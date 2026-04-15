import { config } from '../../config.js';

const SIMPLE_EMBEDDING_MODEL_PREFIX = 'simple-hash-v1';

function normalizeInput(input: string): string {
    return (input || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function fnv1a32(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function normalizeVector(values: number[]): number[] {
    let sum = 0;
    for (const value of values) {
        sum += value * value;
    }
    if (sum <= 0) return values;
    const scale = 1 / Math.sqrt(sum);
    for (let i = 0; i < values.length; i += 1) {
        values[i] *= scale;
    }
    return values;
}

function addFeature(vector: number[], feature: string, weight: number) {
    if (!feature) return;
    const index = fnv1a32(feature) % vector.length;
    vector[index] += weight;
}

function toSimpleEmbedding(input: string, dims: number): number[] {
    const vector = new Array(Math.max(8, dims)).fill(0);
    const normalized = normalizeInput(input);
    if (!normalized) return vector;

    const compact = normalized.replace(/\s+/g, ' ');
    const alnumTokens = compact.match(/[a-z0-9]+/g) || [];
    const cjkBlocks = compact.match(/[\u3400-\u9fff]+/g) || [];

    for (const token of alnumTokens) {
        addFeature(vector, `w:${token}`, 1.2);
        if (token.length >= 4) {
            addFeature(vector, `p:${token.slice(0, 4)}`, 0.55);
            addFeature(vector, `s:${token.slice(-4)}`, 0.55);
        }
    }

    for (let i = 0; i < alnumTokens.length - 1; i += 1) {
        addFeature(vector, `bg:${alnumTokens[i]}_${alnumTokens[i + 1]}`, 0.6);
    }

    for (const block of cjkBlocks) {
        for (let i = 0; i < block.length; i += 1) {
            addFeature(vector, `zh1:${block[i]}`, 1.1);
            if (i + 1 < block.length) {
                addFeature(vector, `zh2:${block[i]}${block[i + 1]}`, 0.8);
            }
        }
    }

    const compactChars = compact.replace(/\s+/g, '');
    for (let i = 0; i < compactChars.length; i += 1) {
        if (i + 3 <= compactChars.length) {
            addFeature(vector, `cg3:${compactChars.slice(i, i + 3)}`, 0.22);
        }
    }

    return normalizeVector(vector);
}

function parseOpenAIEmbeddingsPayload(payload: any, expected: number): number[][] {
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (rows.length !== expected) {
        throw new Error(`Embedding provider returned ${rows.length} vectors, expected ${expected}`);
    }
    return rows
        .slice()
        .sort((a: any, b: any) => Number(a?.index || 0) - Number(b?.index || 0))
        .map((item: any) => {
            if (!Array.isArray(item?.embedding) || item.embedding.length === 0) {
                throw new Error('Embedding provider returned invalid vector');
            }
            return normalizeVector(item.embedding.map((value: any) => Number(value) || 0));
        });
}

async function embedWithOpenAI(inputs: string[]): Promise<{ vectors: number[][]; modelTag: string }> {
    const baseUrl = (config.friendZoneEmbeddingApiBaseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const model = config.friendZoneEmbeddingModel || 'text-embedding-3-small';
    const apiKey = config.friendZoneEmbeddingApiKey || '';
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required for FRIEND_ZONE_EMBEDDING_PROVIDER=openai');
    }

    const response = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            input: inputs,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI embedding request failed (${response.status}): ${body || 'unknown error'}`);
    }

    const payload = await response.json();
    const vectors = parseOpenAIEmbeddingsPayload(payload, inputs.length);
    return {
        vectors,
        modelTag: `openai:${model}`,
    };
}

export function getSimpleEmbeddingModelTag(): string {
    const dims = Math.max(8, config.friendZoneSimpleEmbeddingDims || 384);
    return `${SIMPLE_EMBEDDING_MODEL_PREFIX}:${dims}`;
}

export function getActiveEmbeddingProvider(): 'simple' | 'openai' {
    return config.friendZoneEmbeddingProvider === 'openai' ? 'openai' : 'simple';
}

export function getPreferredEmbeddingModelTag(): string {
    if (getActiveEmbeddingProvider() === 'openai') {
        return `openai:${config.friendZoneEmbeddingModel || 'text-embedding-3-small'}`;
    }
    return getSimpleEmbeddingModelTag();
}

export async function embedFriendZoneTexts(inputs: string[]): Promise<{ vectors: number[][]; modelTag: string; provider: 'simple' | 'openai' }> {
    const normalizedInputs = inputs.map((input) => normalizeInput(input || ''));
    const provider = getActiveEmbeddingProvider();

    if (provider === 'openai') {
        try {
            const embedded = await embedWithOpenAI(normalizedInputs);
            return { ...embedded, provider: 'openai' };
        } catch {
            // Hard fallback to local embedding so posting/querying never hard-fails in production traffic.
        }
    }

    const dims = Math.max(8, config.friendZoneSimpleEmbeddingDims || 384);
    return {
        vectors: normalizedInputs.map((input) => toSimpleEmbedding(input, dims)),
        modelTag: `${SIMPLE_EMBEDDING_MODEL_PREFIX}:${dims}`,
        provider: 'simple',
    };
}

export function parseFloatArray(value: unknown): number[] {
    if (Array.isArray(value)) {
        return value.map((item) => Number(item) || 0);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
        const raw = trimmed.slice(1, -1);
        if (!raw) return [];
        return raw.split(',').map((item) => Number(item.trim()) || 0);
    }
    return [];
}

export function cosineSimilarity(left: number[], right: number[]): number {
    if (!left.length || !right.length) return 0;
    const size = Math.min(left.length, right.length);
    if (size <= 0) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let i = 0; i < size; i += 1) {
        const l = left[i] || 0;
        const r = right[i] || 0;
        dot += l * r;
        leftNorm += l * l;
        rightNorm += r * r;
    }
    if (leftNorm <= 0 || rightNorm <= 0) return 0;
    return dot / Math.sqrt(leftNorm * rightNorm);
}

export function extractKeywordTerms(input: string): string[] {
    const normalized = normalizeInput(input);
    if (!normalized) return [];
    const terms = new Set<string>();
    const latin = normalized.match(/[a-z0-9]{2,}/g) || [];
    for (const token of latin) {
        terms.add(token);
    }
    const cjkChars = normalized.replace(/[^\u3400-\u9fff]/g, '');
    for (let i = 0; i < cjkChars.length; i += 1) {
        terms.add(cjkChars[i]);
        if (i + 1 < cjkChars.length) {
            terms.add(cjkChars.slice(i, i + 2));
        }
    }
    return Array.from(terms);
}
