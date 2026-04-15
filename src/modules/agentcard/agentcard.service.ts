import fsSync from 'node:fs';
import path from 'node:path';
import { pool } from '../../db/pool.js';
import { createUpload, readUploadBuffer, toUploadPublicView, UploadError } from '../upload/upload.service.js';

const CARD_STYLE_VERSION = 2;
const AGENT_CARD_LOGO_RELATIVE_PATH = path.join('src', 'modules', 'agentcard', 'assets', 'logopic.jpg');
let cachedLogoDataUri: string | null | undefined;

interface AgentProfileForCard {
    id: string;
    claw_id: string;
    agent_name: string;
    display_name: string | null;
    description: string | null;
    aiti_type: string | null;
    aiti_summary: string | null;
    owner_name: string | null;
    created_at: string;
}

interface AgentCardJoinRow {
    id: string;
    owner_id: string;
    upload_id: string;
    style_version: number;
    created_at: string;
    updated_at: string;
    agent_name: string;
    claw_id: string;
    filename: string;
    mime_type: string | null;
    size_bytes: number;
    storage_key: string;
    sha256: string;
    storage_mode: string;
    expires_at: string | null;
    max_downloads: number | null;
    download_count: number;
    last_downloaded_at: string | null;
    upload_created_at: string;
}

export class AgentCardError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AgentCardError';
    }
}

function escapeXml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function trimText(input: string | null | undefined, maxLength: number): string {
    const raw = (input || '').trim();
    if (!raw) return '';
    if (raw.length <= maxLength) return raw;
    return `${raw.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function wrapLines(input: string, maxChars = 44, maxLines = 3): string[] {
    const text = trimText(input, maxChars * maxLines);
    if (!text) return [];

    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length <= maxChars) {
            current = next;
            continue;
        }
        if (current) lines.push(current);
        current = word;
        if (lines.length >= maxLines - 1) break;
    }

    if (lines.length < maxLines && current) {
        lines.push(current);
    }

    if (lines.length > maxLines) {
        return lines.slice(0, maxLines);
    }
    return lines;
}

function pickFontSize(input: string, thresholds: Array<{ maxLength: number; size: number }>, fallback: number): number {
    const length = trimText(input, 200).length;
    for (const threshold of thresholds) {
        if (length <= threshold.maxLength) return threshold.size;
    }
    return fallback;
}

function formatJoinedLabel(createdAt: string): string {
    const date = createdAt ? new Date(createdAt) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildMonogram(profile: AgentProfileForCard): string {
    const source = trimText(profile.display_name || profile.agent_name, 40);
    const parts = source.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase().slice(0, 2) || 'AG';
    }
    return source.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AG';
}

function inferAiti(profile: AgentProfileForCard): { label: string; summary: string } {
    const explicitLabel = trimText(profile.aiti_type, 48);
    const explicitSummary = trimText(profile.aiti_summary, 120);
    if (explicitLabel && explicitSummary) {
        return { label: explicitLabel, summary: explicitSummary };
    }

    const text = `${profile.display_name || ''} ${profile.description || ''}`.toLowerCase();

    let inferred = { label: 'Quiet Executor', summary: 'Talks less, delivers strongly' };
    if (/(patient|empathetic|kind|warm|support|understand|collaborat|thoughtful)/.test(text)) {
        inferred = { label: 'Thoughtful Partner', summary: 'Patient, empathetic, and easy to work with' };
    } else if (/(direct|clear|practical|straight|blunt|decisive)/.test(text)) {
        inferred = { label: 'Direct Builder', summary: 'Clear, practical, and action-oriented' };
    } else if (/(calm|steady|stable|reliable|dependable|under pressure)/.test(text)) {
        inferred = { label: 'Calm Operator', summary: 'Calm under pressure, reliable in execution' };
    } else if (/(fast|quick|rapid|ship|momentum|execute fast)/.test(text)) {
        inferred = { label: 'Fast Mover', summary: 'Moves quickly and keeps momentum high' };
    } else if (/(detail|precise|careful|accurate|thorough|meticulous)/.test(text)) {
        inferred = { label: 'Detail Keeper', summary: 'Careful, structured, and detail-aware' };
    } else if (/(strategy|strategic|system|vision|long-term|architecture|big picture)/.test(text)) {
        inferred = { label: 'Big Picture Thinker', summary: 'Sees systems clearly and thinks long-term' };
    } else if (/(guide|teach|mentor|friendly|helpful|onboard)/.test(text)) {
        inferred = { label: 'Friendly Guide', summary: 'Warm, supportive, and easy to learn from' };
    }

    if (explicitLabel && !explicitSummary) {
        return { label: explicitLabel, summary: inferred.summary };
    }
    if (!explicitLabel && explicitSummary) {
        return { label: inferred.label, summary: explicitSummary };
    }
    return inferred;
}

function formatOwnerName(input: string | null | undefined): string {
    const raw = trimText(input, 80);
    if (!raw) return 'Independent owner';
    const local = raw.includes('@') ? raw.split('@')[0] : raw;
    return trimText(local.replace(/[._-]+/g, ' '), 28) || 'Independent owner';
}

function loadAgentCardLogoDataUri(): string | null {
    if (cachedLogoDataUri !== undefined) return cachedLogoDataUri;
    const candidates = [
        path.resolve(process.cwd(), AGENT_CARD_LOGO_RELATIVE_PATH),
        path.resolve(process.cwd(), 'Clawtalk_website', 'logopic.jpg'),
        path.resolve(process.cwd(), 'logopic.jpg'),
    ];
    for (const candidate of candidates) {
        try {
            if (!fsSync.existsSync(candidate)) continue;
            const content = fsSync.readFileSync(candidate);
            cachedLogoDataUri = `data:image/jpeg;base64,${content.toString('base64')}`;
            return cachedLogoDataUri;
        } catch {
            // Try next path candidate.
        }
    }
    cachedLogoDataUri = null;
    return null;
}

function renderAgentCardSvg(profile: AgentProfileForCard): string {
    const logoDataUri = loadAgentCardLogoDataUri();
    const title = trimText(profile.display_name || profile.agent_name, 30);
    const username = profile.agent_name;
    const aiti = inferAiti(profile);
    const aitiSummaryLines = wrapLines(aiti.summary, 32, 2);
    const monogram = buildMonogram(profile);
    const ownerName = formatOwnerName(profile.owner_name);
    const titleFontSize = pickFontSize(title, [
        { maxLength: 14, size: 68 },
        { maxLength: 20, size: 60 },
        { maxLength: 26, size: 52 },
    ], 46);
    const usernameFontSize = pickFontSize(username, [
        { maxLength: 18, size: 29 },
        { maxLength: 24, size: 26 },
    ], 23);
    const ownerFontSize = pickFontSize(ownerName, [
        { maxLength: 12, size: 28 },
        { maxLength: 18, size: 25 },
    ], 22);
    const brandMark = logoDataUri
        ? `<image href="${logoDataUri}" x="86" y="80" width="30" height="30" preserveAspectRatio="xMidYMid slice" opacity="0.98" />`
        : `<circle cx="101" cy="95" r="14" fill="#f5fff9" opacity="0.92" />`;
    const aitiSummarySvg = aitiSummaryLines
        .map((line, idx) => `<text x="92" y="${468 + idx * 24}" fill="#ebfff4" font-size="20" font-family="'Helvetica Neue', Arial, sans-serif">${escapeXml(line)}</text>`)
        .join('');
    const connectHintLines = wrapLines('Use OpenClaw to open the verify link and send a friend request', 30, 3)
        .map(
            (line, idx) =>
                `<text x="724" y="${428 + idx * 24}" fill="#e7fff2" font-size="19" font-family="'Helvetica Neue', Arial, sans-serif">${escapeXml(line)}</text>`
        )
        .join('');

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Clawtalk Agent Card">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="48" y1="34" x2="1120" y2="596">
      <stop offset="0%" stop-color="#8af6bb" />
      <stop offset="46%" stop-color="#57d89f" />
      <stop offset="100%" stop-color="#27ac7c" />
    </linearGradient>
    <radialGradient id="glowA" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(250 130) rotate(40) scale(340 240)">
      <stop offset="0%" stop-color="#effff6" stop-opacity="0.55" />
      <stop offset="100%" stop-color="#b8ffd8" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glowB" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(980 540) rotate(-30) scale(320 240)">
      <stop offset="0%" stop-color="#16916a" stop-opacity="0.22" />
      <stop offset="100%" stop-color="#0a3c30" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="glass" gradientUnits="userSpaceOnUse" x1="74" y1="110" x2="1110" y2="548">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.03" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" rx="34" fill="url(#bg)" />
  <rect width="1200" height="630" rx="34" fill="url(#glowA)" />
  <rect width="1200" height="630" rx="34" fill="url(#glowB)" />
  <rect x="56" y="56" width="1088" height="518" rx="30" fill="url(#glass)" />

  ${brandMark}
  <text x="128" y="100" fill="#effff8" font-size="24" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700" letter-spacing="1.4">CLAWTALK</text>
  <text x="92" y="186" fill="#ffffff" font-size="${titleFontSize}" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700">${escapeXml(title)}</text>
  <text x="92" y="232" fill="#f1fff7" font-size="${usernameFontSize}" font-family="'Helvetica Neue', Arial, sans-serif">@${escapeXml(username)}</text>
  <text x="92" y="308" fill="#daf9ea" font-size="16" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700" letter-spacing="1.2">OWNER</text>
  <text x="92" y="344" fill="#ffffff" font-size="${ownerFontSize}" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700">${escapeXml(ownerName)}</text>

  <text x="92" y="398" fill="#daf9ea" font-size="16" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700" letter-spacing="1.2">AITI</text>
  <text x="92" y="430" fill="#ffffff" font-size="34" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700">${escapeXml(aiti.label)}</text>
  ${aitiSummarySvg}

  <circle cx="930" cy="178" r="104" fill="#f3fff8" fill-opacity="0.82" />
  <text x="930" y="199" text-anchor="middle" fill="#14966c" font-size="72" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700">${escapeXml(monogram)}</text>

  <text x="724" y="300" fill="#daf9ea" font-size="16" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700" letter-spacing="1.2">ADD FRIEND</text>
  <text x="724" y="340" fill="#ffffff" font-size="34" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700">Via OpenClaw</text>
  ${connectHintLines}

  <text x="724" y="520" fill="#daf9ea" font-size="14" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700" letter-spacing="1.1">TARGET ACCOUNT</text>
  <text x="724" y="556" fill="#ffffff" font-size="28" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700">@${escapeXml(username)}</text>
</svg>
`.trim();
}

function mapCardRow(row: AgentCardJoinRow) {
    const upload = toUploadPublicView({
        id: row.upload_id,
        uploader_id: row.owner_id,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_key: row.storage_key,
        sha256: row.sha256,
        storage_mode: row.storage_mode,
        expires_at: row.expires_at,
        max_downloads: row.max_downloads,
        download_count: row.download_count,
        last_downloaded_at: row.last_downloaded_at,
        created_at: row.upload_created_at,
    });

    return {
        id: row.id,
        owner_id: row.owner_id,
        agent_username: row.agent_name,
        claw_id: row.claw_id,
        upload_id: row.upload_id,
        style_version: Number(row.style_version || CARD_STYLE_VERSION),
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
        upload,
    };
}

async function fetchCardRow(ownerId: string): Promise<AgentCardJoinRow | null> {
    const { rows } = await pool.query(
        `SELECT ac.id,
                ac.owner_id,
                ac.upload_id,
                ac.style_version,
                ac.created_at,
                ac.updated_at,
                a.agent_name,
                a.claw_id,
                u.filename,
                u.mime_type,
                u.size_bytes,
                u.storage_key,
                u.sha256,
                u.storage_mode,
                u.expires_at,
                u.max_downloads,
                u.download_count,
                u.last_downloaded_at,
                u.created_at AS upload_created_at
         FROM agent_cards ac
         JOIN agents a ON a.id = ac.owner_id
         JOIN uploads u ON u.id = ac.upload_id
         WHERE ac.owner_id = $1
         LIMIT 1`,
        [ownerId]
    );
    return rows[0] || null;
}

async function fetchCardRowByCardId(cardId: string): Promise<AgentCardJoinRow | null> {
    const { rows } = await pool.query(
        `SELECT ac.id,
                ac.owner_id,
                ac.upload_id,
                ac.style_version,
                ac.created_at,
                ac.updated_at,
                a.agent_name,
                a.claw_id,
                u.filename,
                u.mime_type,
                u.size_bytes,
                u.storage_key,
                u.sha256,
                u.storage_mode,
                u.expires_at,
                u.max_downloads,
                u.download_count,
                u.last_downloaded_at,
                u.created_at AS upload_created_at
         FROM agent_cards ac
         JOIN agents a ON a.id = ac.owner_id
         JOIN uploads u ON u.id = ac.upload_id
         WHERE ac.id = $1
         LIMIT 1`,
        [cardId]
    );
    return rows[0] || null;
}

async function fetchAgentProfile(ownerId: string): Promise<AgentProfileForCard> {
    const { rows } = await pool.query(
        `SELECT a.id,
                a.claw_id,
                a.agent_name,
                a.display_name,
                a.description,
                a.aiti_type,
                a.aiti_summary,
                a.created_at,
                COALESCE(o.display_name, o.email) AS owner_name
         FROM agents a
         LEFT JOIN owners o ON o.id = a.primary_owner_id
         WHERE a.id = $1
         LIMIT 1`,
        [ownerId]
    );
    if (!rows.length) {
        throw new AgentCardError('Agent not found', 404);
    }
    return rows[0];
}

export async function getAgentCardById(cardId: string) {
    const row = await fetchCardRowByCardId(cardId);
    if (!row) {
        throw new AgentCardError('Agent card not found', 404);
    }
    return mapCardRow(row);
}

export function buildAgentCardVerifyUrl(baseUrl: string, cardId: string): string {
    const normalized = baseUrl.replace(/\/+$/, '');
    return `${normalized}/api/v1/agent-card/verify/${encodeURIComponent(cardId)}`;
}

export function buildAgentCardPublicImageUrl(baseUrl: string, cardId: string): string {
    const normalized = baseUrl.replace(/\/+$/, '');
    // Use explicit .png suffix to maximize inline preview compatibility in chat channels (e.g. Discord).
    return `${normalized}/api/v1/agent-card/public/${encodeURIComponent(cardId)}/image.png`;
}

export async function getAgentCardImageById(cardId: string): Promise<{
    cardId: string;
    filename: string;
    mimeType: string;
    storageKey: string;
    sizeBytes: number;
}> {
    const row = await fetchCardRowByCardId(cardId);
    if (!row) {
        throw new AgentCardError('Agent card not found', 404);
    }

    return {
        cardId: row.id,
        filename: row.filename || `${row.agent_name}-agent-card.svg`,
        mimeType: row.mime_type || 'application/octet-stream',
        storageKey: row.storage_key,
        sizeBytes: Number(row.size_bytes || 0),
    };
}

export function buildAgentCardShareText(params: {
    baseUrl: string;
    agentUsername: string;
    clawId: string;
    cardId: string;
}): string {
    const verifyUrl = buildAgentCardVerifyUrl(params.baseUrl, params.cardId);
    const skillUrl = `${params.baseUrl.replace(/\/+$/, '')}/skill.md`;
    return [
        `Read ${skillUrl} and help me connect with this Clawtalk agent.`,
        `Target Agent Username: ${params.agentUsername}`,
        `Target Claw ID: ${params.clawId}`,
        `Card Verify: ${verifyUrl}`,
        'If verified, send a friend request with: "Hi, let us connect on Clawtalk."',
    ].join('\n');
}

export async function getMyAgentCard(ownerId: string) {
    const ensured = await ensureAgentCardForOwner(ownerId);
    return ensured.card;
}

export async function ensureAgentCardForOwner(ownerId: string): Promise<{ card: ReturnType<typeof mapCardRow>; created: boolean }> {
    const existing = await fetchCardRow(ownerId);
    if (existing && Number(existing.style_version || 0) >= CARD_STYLE_VERSION) {
        try {
            await readUploadBuffer(existing.storage_key);
            return { card: mapCardRow(existing), created: false };
        } catch (err) {
            if (!(err instanceof UploadError) || err.statusCode !== 404) {
                throw err;
            }
            // Existing card metadata points to a missing file; regenerate below.
        }
    }

    const profile = await fetchAgentProfile(ownerId);
    const svg = renderAgentCardSvg(profile);
    const base64 = Buffer.from(svg, 'utf-8').toString('base64');

    const upload = await createUpload(
        ownerId,
        `${profile.agent_name}-agent-card.svg`,
        base64,
        'image/svg+xml',
        { storageMode: 'persistent' }
    );

    if (existing) {
        await pool.query(
            `UPDATE agent_cards
             SET upload_id = $2,
                 style_version = $3,
                 updated_at = NOW()
             WHERE id = $1`,
            [existing.id, upload.id, CARD_STYLE_VERSION]
        );
    } else {
        try {
            await pool.query(
                `INSERT INTO agent_cards (owner_id, upload_id, style_version)
                 VALUES ($1, $2, $3)`,
                [ownerId, upload.id, CARD_STYLE_VERSION]
            );
        } catch (err: any) {
            if (err?.code !== '23505') {
                throw err;
            }
        }
    }

    const saved = await fetchCardRow(ownerId);
    if (!saved) {
        throw new AgentCardError('Failed to create agent card', 500);
    }
    return { card: mapCardRow(saved), created: !existing };
}
