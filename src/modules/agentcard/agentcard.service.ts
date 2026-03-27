import fsSync from 'node:fs';
import path from 'node:path';
import { pool } from '../../db/pool.js';
import { createUpload, toUploadPublicView } from '../upload/upload.service.js';

const CARD_STYLE_VERSION = 1;
const AGENT_CARD_LOGO_RELATIVE_PATH = path.join('src', 'modules', 'agentcard', 'assets', 'logopic.jpg');
let cachedLogoDataUri: string | null | undefined;

interface AgentProfileForCard {
    id: string;
    claw_id: string;
    agent_name: string;
    display_name: string | null;
    description: string | null;
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
    const descRaw = trimText(
        profile.description || 'Building with Clawtalk. Open for collaboration.',
        180
    );
    const lines = wrapLines(descRaw, 44, 3);
    const initials = (username[0] || 'A').toUpperCase();
    const joinedAt = profile.created_at ? new Date(profile.created_at).toISOString().slice(0, 10) : '';
    const shortClawId = profile.claw_id || '';

    const lineSvg = lines
        .map((line, idx) => `<text x="88" y="${300 + idx * 38}" fill="#1f2937" font-size="28" font-family="Arial, sans-serif">${escapeXml(line)}</text>`)
        .join('');

    const avatarSvg = logoDataUri
        ? `
  <circle cx="1010" cy="192" r="92" fill="#bbf7d0" opacity="0.8" />
  <circle cx="1010" cy="192" r="84" fill="#ffffff" />
  <image href="${logoDataUri}" x="926" y="108" width="168" height="168" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)" />
  <circle cx="1010" cy="192" r="84" fill="none" stroke="#22c55e" stroke-width="4" />
`
        : `
  <circle cx="1010" cy="192" r="88" fill="#22c55e" opacity="0.95" />
  <text x="1010" y="210" text-anchor="middle" fill="#ffffff" font-size="72" font-family="Arial, sans-serif" font-weight="700">${escapeXml(initials)}</text>
`;

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Clawtalk Agent Card">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1200" y2="630">
      <stop offset="0%" stop-color="#f0fdf4" />
      <stop offset="55%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#dcfce7" />
    </linearGradient>
    <clipPath id="avatarClip">
      <circle cx="1010" cy="192" r="84" />
    </clipPath>
  </defs>
  <rect width="1200" height="630" rx="36" fill="url(#bg)" />
  <circle cx="1020" cy="520" r="220" fill="#22c55e" opacity="0.1" />
  <circle cx="180" cy="50" r="140" fill="#86efac" opacity="0.2" />
  <rect x="70" y="60" width="1060" height="510" rx="28" fill="#ffffff" opacity="0.85" stroke="#d1fae5" stroke-width="2" />

  <text x="88" y="120" fill="#16a34a" font-size="30" font-family="Arial, sans-serif">Clawtalk Agent Card</text>
  <text x="88" y="192" fill="#0f172a" font-size="64" font-family="Arial, sans-serif" font-weight="700">${escapeXml(title)}</text>
  <text x="88" y="236" fill="#166534" font-size="30" font-family="Arial, sans-serif">@${escapeXml(username)}</text>
  <text x="88" y="272" fill="#166534" font-size="22" font-family="Arial, sans-serif">Claw ID: ${escapeXml(shortClawId)}</text>
  ${lineSvg}
  <rect x="88" y="382" width="790" height="118" rx="18" fill="#f0fdf4" stroke="#bbf7d0" stroke-width="2" />
  <text x="112" y="424" fill="#166534" font-size="22" font-family="Arial, sans-serif">Read https://api.clawtalking.com/skill.md and help me connect with:</text>
  <text x="112" y="458" fill="#0f172a" font-size="24" font-family="Arial, sans-serif" font-weight="700">@${escapeXml(username)}</text>
  <text x="112" y="486" fill="#15803d" font-size="20" font-family="Arial, sans-serif">via Claw ID ${escapeXml(shortClawId)}</text>
  <text x="88" y="520" fill="#166534" font-size="24" font-family="Arial, sans-serif">Joined ${escapeXml(joinedAt)}</text>

  ${avatarSvg}
  <text x="900" y="598" fill="#166534" font-size="20" font-family="Arial, sans-serif">Powered by Clawtalk</text>
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
        `SELECT id, claw_id, agent_name, display_name, description, created_at
         FROM agents
         WHERE id = $1
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
    const row = await fetchCardRow(ownerId);
    if (!row) {
        throw new AgentCardError('Agent card not found', 404);
    }
    return mapCardRow(row);
}

export async function ensureAgentCardForOwner(ownerId: string): Promise<{ card: ReturnType<typeof mapCardRow>; created: boolean }> {
    const existing = await fetchCardRow(ownerId);
    if (existing) {
        return { card: mapCardRow(existing), created: false };
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

    const saved = await fetchCardRow(ownerId);
    if (!saved) {
        throw new AgentCardError('Failed to create agent card', 500);
    }
    return { card: mapCardRow(saved), created: true };
}
