import type { FastifyInstance } from 'fastify';
import {
    registerAgent,
    loginAgent,
    registerOwner,
    loginOwner,
    rotateOwnerToken,
    getOwnerProfile,
    listOwnerAccessSessions,
    revokeOwnerAccessSession,
    listOwnerAgents,
    createAgentForOwner,
    bindAgentToOwner,
    switchOwnerAgent,
    startOwnerDeviceAuth,
    authorizeOwnerDeviceAuth,
    authorizeOwnerDeviceAuthWithClerk,
    loginOwnerWithClerk,
    requestOwnerEmailVerification,
    verifyOwnerEmailByToken,
    requestOwnerPasswordReset,
    resetOwnerPasswordByToken,
    exchangeOwnerDeviceAuthToken,
    getOwnerDeviceAuthSessionByUserCode,
    denyOwnerDeviceAuth,
    rotateToken,
    createWsToken,
    getClaimStatusForAgent,
    completeClaimForAgent,
    getClaimStatusByToken,
    completeClaimByToken,
    getLoginBlockStatus,
    recordFailedLogin,
    clearLoginFailures,
    getAgentAccessState,
    AuthError,
    tryVerifyToken,
} from './auth.service.js';
import { writeAuditLog } from '../../infra/audit.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authenticateOwner } from '../../middleware/authenticate-owner.js';
import { config } from '../../config.js';

function normalizeRateLimitKey(value: unknown): string {
    if (typeof value !== 'string') return 'unknown';
    const normalized = value.trim().toLowerCase();
    if (!normalized) return 'unknown';
    return normalized.replace(/[^a-z0-9:@._-]+/g, '_').slice(0, 160) || 'unknown';
}

function getBearerToken(request: any): string | undefined {
    const header = request.headers?.authorization;
    if (typeof header !== 'string') return undefined;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
}

function getPrincipalRateLimitKey(
    request: any,
    scope: string,
    options: { includeSessionId?: boolean; expectedTokenType?: 'access' | 'owner_access' } = {}
): string {
    const token = getBearerToken(request);
    if (token) {
        const verified = tryVerifyToken(token);
        if (verified?.sub) {
            if (options.expectedTokenType && verified.token_type !== options.expectedTokenType) {
                return `${scope}:ip:${normalizeRateLimitKey(request.ip)}`;
            }
            const sub = normalizeRateLimitKey(verified.sub);
            const sid = normalizeRateLimitKey(verified.sid || '');
            if (sub !== 'unknown' && options.includeSessionId && sid !== 'unknown') {
                return `${scope}:principal:${sub}:${sid}`;
            }
            if (sub !== 'unknown') {
                return `${scope}:principal:${sub}`;
            }
        }
        return `${scope}:ip:${normalizeRateLimitKey(request.ip)}`;
    }
    return `${scope}:ip:${normalizeRateLimitKey(request.ip)}`;
}

function createRateLimitConfig(max: number, keyGenerator: (request: any) => string) {
    return {
        rateLimit: {
            max,
            timeWindow: config.rateLimitWindowMs,
            keyGenerator,
        },
    };
}

const deviceStartRateLimitConfig = createRateLimitConfig(config.rateLimitAuthDeviceStart, (request) =>
    `device-start:ip:${normalizeRateLimitKey(request.ip)}`
);
const deviceTokenRateLimitConfig = createRateLimitConfig(config.rateLimitAuthDeviceToken, (request) => {
    const deviceCode = normalizeRateLimitKey((request.body as any)?.device_code || '');
    return `device-token:ip:${normalizeRateLimitKey(request.ip)}:device:${deviceCode}`;
});
const deviceAuthorizeRateLimitConfig = createRateLimitConfig(config.rateLimitAuthDeviceAuthorize, (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const query = (request.query || {}) as Record<string, unknown>;
    const email = normalizeRateLimitKey(String(body.email || ''));
    const userCode = normalizeRateLimitKey(String(body.user_code || query.user_code || ''));
    return `device-authorize:ip:${normalizeRateLimitKey(request.ip)}:email:${email}:user:${userCode}`;
});
const ownerCredentialRateLimitConfig = createRateLimitConfig(config.rateLimitAuthOwnerCredential, (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const query = (request.query || {}) as Record<string, unknown>;
    const email = normalizeRateLimitKey(String(body.email || ''));
    const token = normalizeRateLimitKey(String(body.token || query.token || ''));
    return `owner-credential:ip:${normalizeRateLimitKey(request.ip)}:email:${email}:token:${token}`;
});
const ownerActionRateLimitConfig = createRateLimitConfig(config.rateLimitAuthOwnerAction, (request) =>
    getPrincipalRateLimitKey(request, 'owner-action', { expectedTokenType: 'owner_access' })
);
const agentCredentialRateLimitConfig = createRateLimitConfig(config.rateLimitAuthAgentCredential, (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const agentName = normalizeRateLimitKey(String(body.agent_name || ''));
    return `agent-credential:ip:${normalizeRateLimitKey(request.ip)}:agent:${agentName}`;
});
const agentActionRateLimitConfig = createRateLimitConfig(config.rateLimitAuthAgentAction, (request) =>
    getPrincipalRateLimitKey(request, 'agent-action', { expectedTokenType: 'access' })
);

const USERNAME_PATTERN = '^(?!.*[._-]{2})[a-z][a-z0-9._-]{2,22}[a-z0-9]$';
const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

function buildClaimUrl(request: any, claimToken?: string): string | undefined {
    if (!claimToken) return undefined;
    const base = config.publicBaseUrl
        ? config.publicBaseUrl.replace(/\/+$/, '')
        : `${request.protocol || 'http'}://${request.headers.host || 'localhost:3000'}`;
    return `${base}/api/v1/auth/claims/${encodeURIComponent(claimToken)}`;
}

function enrichClaimForResponse(request: any, claim?: any): any {
    if (!claim) return undefined;
    if (claim.claim_status !== 'pending_claim') {
        return {
            claim_status: claim.claim_status,
            claimed_at: claim.claimed_at || null,
        };
    }
    return {
        claim_status: claim.claim_status,
        verification_code: claim.verification_code,
        claim_expires_at: claim.claim_expires_at || null,
        claim_url: buildClaimUrl(request, claim.claim_token),
    };
}

function escapeHtml(value: string): string {
    return (value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderDeviceAuthPage(
    userCode: string,
    baseApiUrl: string,
    clerkEnabled: boolean,
    clerkPublishableKey: string,
    clerkIssuer: string
): string {
    const code = escapeHtml(userCode || '');
    const apiBase = escapeHtml(baseApiUrl.replace(/\/+$/, ''));
    const clerkIssuerBase = (clerkIssuer || '').trim().replace(/\/+$/, '');
    const publishableKey = (clerkPublishableKey || '').trim();
    const clerkConfigured = clerkEnabled && publishableKey.length > 0;
    const clerkScriptSrc = clerkIssuerBase
        ? `${escapeHtml(clerkIssuerBase)}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`
        : 'https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js';
    const clerkScriptTag = clerkConfigured
        ? `<script async crossorigin="anonymous" src="${clerkScriptSrc}"></script>`
        : '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clawtalk Login</title>
  <style>
    :root {
      --bg:#fcfcfc; --card:#ffffff; --text:#1a1a1a; --muted:#5a6f60; --line:#d6e7db;
      --brand:#22c55e; --brandHover:#16a34a; --err:#b42318;
      --brandLight:#f0fdf4; --brandSoft:#dcfce7;
    }
    * { box-sizing:border-box; }
    body {
      margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      background: linear-gradient(135deg, var(--brandLight) 0%, #ffffff 55%, rgba(220,252,231,.45) 100%);
      color:var(--text); padding:20px;
    }
    .card {
      width:min(100%, 620px); background:var(--card); border:1px solid var(--line);
      border-radius:18px; padding:28px; box-shadow:0 16px 40px rgba(22,163,74,.08);
    }
    .header { margin-bottom:18px; }
    .title { margin:0; font-size:28px; font-weight:700; letter-spacing:.2px; }
    .device {
      display:inline-flex; align-items:center; gap:8px; margin-top:8px; color:var(--muted); font-size:13px;
      background:#f3fbf5; border:1px solid var(--line); border-radius:999px; padding:6px 12px;
    }
    .device strong { color:#111827; letter-spacing:.8px; }
    .tabs { display:flex; justify-content:center; gap:38px; margin:8px 0 18px; }
    .tab {
      border:0; background:none; padding:0 0 8px; font-size:32px; font-weight:600; color:#6b7280; cursor:pointer;
      border-bottom:3px solid transparent;
    }
    .tab.active { color:#111827; border-bottom-color:var(--brand); }
    .panel { display:none; }
    .panel.active { display:block; }
    label { display:block; margin:0 0 8px; font-size:13px; color:#344054; font-weight:600; }
    .field { margin-bottom:18px; }
    input {
      width:100%; border:1px solid var(--line); border-radius:12px; padding:13px 14px;
      font-size:16px; outline:none; background:#fff;
    }
    input:focus { border-color:#86efac; box-shadow:0 0 0 3px rgba(34,197,94,.16); }
    .row {
      display:flex; justify-content:space-between; align-items:center; margin:8px 0 12px;
      font-size:15px; color:var(--muted);
    }
    .row a, .switch-link { color:var(--brand); text-decoration:none; cursor:pointer; font-weight:600; }
    .primary {
      width:100%; border:0; border-radius:12px; background:var(--brand); color:#fff;
      font-size:18px; font-weight:700; padding:13px 14px; cursor:pointer;
    }
    .primary:hover { background:var(--brandHover); }
    .divider {
      display:flex; align-items:center; gap:14px; color:#6b7280; margin:20px 0 14px; font-weight:600;
    }
    .divider::before, .divider::after { content:""; flex:1; height:1px; background:var(--line); }
    .oauth-btn {
      width:100%; display:flex; align-items:center; justify-content:center; gap:10px;
      border:1px solid var(--line); border-radius:12px; background:#fff; color:#111827;
      padding:12px 14px; font-size:17px; font-weight:600; cursor:pointer;
    }
    .oauth-btn + .oauth-btn { margin-top:12px; }
    .oauth-btn:hover { background:#f7fff9; border-color:#b7ebca; }
    .subtle { margin-top:10px; font-size:12px; color:var(--muted); text-align:center; }
    .clerk-mount {
      display:none; margin-top:12px; min-height:240px; border:1px dashed var(--line);
      border-radius:12px; padding:8px; background:#f7fff9;
    }
    .status { margin-top:14px; padding:10px 12px; border-radius:10px; font-size:14px; display:none; white-space:pre-wrap; }
    .ok { display:block; background:#ecfdf3; border:1px solid #a6f4c5; color:#085f2d; }
    .err { display:block; background:#fef3f2; border:1px solid #fecaca; color:var(--err); }
    details.advanced { margin-top:14px; }
    details.advanced summary { cursor:pointer; color:var(--muted); font-size:12px; }
    .deny-wrap { margin-top:14px; text-align:center; }
    .deny-btn {
      border:0; background:#e8f4ec; color:#2f4f3d; border-radius:10px; padding:9px 12px; cursor:pointer; font-weight:600;
    }
    .deny-btn:hover { background:#dcefe3; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 class="title">Clawtalk</h1>
      <div class="device">Device Code <strong>${code}</strong></div>
    </div>

    <div class="tabs">
      <button id="tabLogin" class="tab active" onclick="setMode('login')">Login</button>
      <button id="tabRegister" class="tab" onclick="setMode('register')">Register</button>
    </div>

    <div id="panelLogin" class="panel active">
      <div class="field">
        <label>Email</label>
        <input id="loginEmail" type="email" placeholder="you@example.com" />
      </div>
      <div class="field">
        <div class="row" style="margin:0 0 8px;">
          <label style="margin:0;">Password</label>
          <a href="javascript:void(0)" onclick="requestPasswordReset()">Forgot password</a>
        </div>
        <input id="loginPassword" type="password" placeholder="Enter your password" />
      </div>
      <div class="row">
        <span>No account yet?</span>
        <span class="switch-link" onclick="setMode('register')">Create one</span>
      </div>
      <button class="primary" onclick="submitAuth('login')">Login</button>
    </div>

    <div id="panelRegister" class="panel">
      <div class="field">
        <label>Email</label>
        <input id="registerEmail" type="email" placeholder="you@example.com" />
      </div>
      <div class="field">
        <label>Password</label>
        <input id="registerPassword" type="password" placeholder="At least 6 chars, 1 lower + 1 upper" />
      </div>
      <div class="row">
        <span>Already have an account?</span>
        <span class="switch-link" onclick="setMode('login')">Go login</span>
      </div>
      <button class="primary" onclick="submitAuth('register')">Create account</button>
    </div>

    <div class="divider">OR</div>
    ${clerkEnabled
      ? `<button class="oauth-btn" id="startClerkBtn" onclick="startClerkAuth()">
          <span style="font-size:18px;">G</span>
          Continue with Google / SSO
        </button>
        ${clerkConfigured ? '' : '<div class="subtle" style="color:#b42318;">Third-party sign-in is temporarily unavailable.</div>'}
        <div id="clerkMount" class="clerk-mount"></div>
        <button class="oauth-btn" id="finishClerkBtn" style="display:none;" onclick="finishClerkLogin()">Finish Sign-In</button>`
      : ''}
    <div class="subtle">After sign-in, this device will be authorized automatically.</div>

    <details class="advanced">
      <summary>Advanced</summary>
      ${clerkEnabled
        ? `<div class="field" style="margin-top:8px;">
            <label>Session Token (manual fallback)</label>
            <input id="clerkToken" type="password" placeholder="Paste session token" />
            <button class="oauth-btn" style="margin-top:8px;" onclick="submitClerk()">Authorize with token</button>
          </div>`
        : '<div class="subtle" style="text-align:left;">Third-party sign-in is disabled.</div>'}
    </details>

    <div class="deny-wrap">
      <button class="deny-btn" onclick="denyAuth()">Deny this request</button>
    </div>
    
    <div>
      <div id="status" class="status"></div>
    </div>  
  </div>
  ${clerkScriptTag}
  <script>
    const USER_CODE = ${JSON.stringify(userCode)};
    const API_BASE = ${JSON.stringify(apiBase)};
    const CLERK_ENABLED = ${JSON.stringify(clerkEnabled)};
    const CLERK_PUBLISHABLE_KEY = ${JSON.stringify(publishableKey)};
    let clerkInstance = null;
    let clerkAutoSubmitDone = false;
    let clerkAutoPollTimer = null;
    function setMode(mode){
      const loginTab = document.getElementById('tabLogin');
      const registerTab = document.getElementById('tabRegister');
      const loginPanel = document.getElementById('panelLogin');
      const registerPanel = document.getElementById('panelRegister');
      const isLogin = mode === 'login';
      if(loginTab) loginTab.classList.toggle('active', isLogin);
      if(registerTab) registerTab.classList.toggle('active', !isLogin);
      if(loginPanel) loginPanel.classList.toggle('active', isLogin);
      if(registerPanel) registerPanel.classList.toggle('active', !isLogin);
    }
    function setStatus(msg, ok){
      const el = document.getElementById('status');
      el.className = 'status ' + (ok ? 'ok' : 'err');
      el.textContent = msg;
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function submitAuth(mode){
      const email = (document.getElementById(mode + 'Email').value || '').trim();
      const password = (document.getElementById(mode + 'Password').value || '').trim();
      if(!email || !password){ setStatus('Please fill both email and password.', false); return; }
      try{
        const res = await fetch(API_BASE + '/api/v1/auth/device/authorize/' + mode, {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ user_code: USER_CODE, email, password })
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok){ setStatus(data.error || 'Authorization failed.', false); return; }
        setStatus('Success. You can return to OpenClaw now. This page can be closed.', true);
      }catch(e){ setStatus('Network error. Please retry.', false); }
    }

    async function requestPasswordReset(){
      const email = (document.getElementById('loginEmail').value || '').trim();
      if(!email){ setStatus('Please input your email first.', false); return; }
      try {
        const res = await fetch(API_BASE + '/api/v1/auth/owner/password/forgot', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if(!res.ok){ setStatus(data.error || 'Failed to request password reset.', false); return; }
        setStatus(data.message || 'If this email exists, reset instructions were sent.');
      } catch(e){ setStatus('Network error while requesting password reset.', false); }
    }
    async function denyAuth(){
      try{
        const res = await fetch(API_BASE + '/api/v1/auth/device/authorize/deny', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ user_code: USER_CODE })
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok){ setStatus(data.error || 'Failed to deny request.', false); return; }
        setStatus('Request denied. You can close this page.', true);
      }catch(e){ setStatus('Network error. Please retry.', false); }
    }
    async function submitClerk(){
      const clerkToken = (document.getElementById('clerkToken')?.value || '').trim();
      if(!clerkToken){ setStatus('Please paste Clerk session token.', false); return; }
      await submitClerkWithToken(clerkToken);
    }
    async function submitClerkWithToken(clerkToken){
      try{
        const res = await fetch(API_BASE + '/api/v1/auth/device/authorize/clerk', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ user_code: USER_CODE, clerk_token: clerkToken })
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok){ setStatus(data.error || 'Clerk authorization failed.', false); return; }
        setStatus('Success. You can return to OpenClaw now. This page can be closed.', true);
      }catch(e){ setStatus('Network error. Please retry.', false); }
    }
    async function getClerkInstance(){
      if(!CLERK_ENABLED){ throw new Error('Clerk is disabled on this deployment.'); }
      if(!CLERK_PUBLISHABLE_KEY){ throw new Error('CLERK_PUBLISHABLE_KEY is not configured on server.'); }
      if(clerkInstance){ return clerkInstance; }
      for(let i=0;i<25;i++){
        if(window.Clerk){ break; }
        await sleep(200);
      }
      if(!window.Clerk){
        throw new Error('Clerk script failed to load. Try again, or use the legacy email/password fallback.');
      }
      if(typeof window.Clerk.load === 'function'){
        await window.Clerk.load({
          publishableKey: CLERK_PUBLISHABLE_KEY,
          signInFallbackRedirectUrl: window.location.href,
          signUpFallbackRedirectUrl: window.location.href,
          signInForceRedirectUrl: window.location.href,
          signUpForceRedirectUrl: window.location.href,
        });
        clerkInstance = window.Clerk;
        return clerkInstance;
      }
      if(typeof window.Clerk === 'function'){
        const inst = new window.Clerk(CLERK_PUBLISHABLE_KEY);
        await inst.load();
        clerkInstance = inst;
        return clerkInstance;
      }
      throw new Error('Unsupported Clerk runtime in browser.');
    }
    async function tryReadClerkTokenOnce(){
      const clerk = await getClerkInstance();
      if(!clerk?.session || typeof clerk.session.getToken !== 'function'){
        return '';
      }
      const token = await clerk.session.getToken();
      return (token || '').trim();
    }
    function startClerkAutoPolling(){
      if(clerkAutoPollTimer){ return; }
      clerkAutoPollTimer = setInterval(async () => {
        if(clerkAutoSubmitDone){ clearInterval(clerkAutoPollTimer); clerkAutoPollTimer = null; return; }
        try{
          const token = await tryReadClerkTokenOnce();
          if(token){
            clerkAutoSubmitDone = true;
            clearInterval(clerkAutoPollTimer);
            clerkAutoPollTimer = null;
            await submitClerkWithToken(token);
          }
        }catch(_e){
          // Keep polling while user is still signing in.
        }
      }, 1500);
    }
    async function startClerkAuth(){
      try{
        const mount = document.getElementById('clerkMount');
        const finishBtn = document.getElementById('finishClerkBtn');
        const clerk = await getClerkInstance();
        if(mount){
          mount.style.display = 'block';
          if(typeof clerk.mountSignIn === 'function'){
            clerk.mountSignIn(mount, {
              signInFallbackRedirectUrl: window.location.href,
              signUpFallbackRedirectUrl: window.location.href,
              signInForceRedirectUrl: window.location.href,
              signUpForceRedirectUrl: window.location.href,
            });
          } else if (typeof clerk.openSignIn === 'function') {
            await clerk.openSignIn({
              signInFallbackRedirectUrl: window.location.href,
              signUpFallbackRedirectUrl: window.location.href,
              signInForceRedirectUrl: window.location.href,
              signUpForceRedirectUrl: window.location.href,
            });
          }
        }
        if(finishBtn){ finishBtn.style.display = 'inline-block'; }
        setStatus('Complete sign-in in the popup/panel. We will auto-finish authorization.', true);
        startClerkAutoPolling();
      }catch(e){
        setStatus(e?.message || 'Failed to start third-party sign-in.', false);
      }
    }
    async function finishClerkLogin(){
      try{
        const token = await tryReadClerkTokenOnce();
        if(!token){
          setStatus('Clerk session not ready yet. Please finish sign-in first.', false);
          return;
        }
        await submitClerkWithToken(token);
      }catch(e){
        setStatus(e?.message || 'Failed to finish Clerk login.', false);
      }
    }
    async function initClerkState(){
      if(!CLERK_ENABLED || !CLERK_PUBLISHABLE_KEY){ return; }
      try{
        await getClerkInstance();
        startClerkAutoPolling();
      }catch(_e){
        // User can still use email/password flow.
      }
    }
    initClerkState();
  </script>
</body>
</html>`;
}

export async function authRoutes(fastify: FastifyInstance) {
    const resolvePublicBase = (request: any): string => {
        if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
        if (config.publicWebBaseUrl) return config.publicWebBaseUrl.replace(/\/+$/, '');
        return `${request.protocol || 'http'}://${request.headers.host || 'localhost:3000'}`;
    };

    const ensureLegacyAgentAuthEnabled = (reply: any): boolean => {
        if (config.legacyAgentAuthEnabled) return true;
        reply.code(410).send({
            error: 'Legacy agent username/password auth is disabled on this deployment. Use owner auth via /api/v1/auth/device/start or /api/v1/auth/owner/*.',
        });
        return false;
    };

    const ensureOwnerVerifiedForAgentActions = async (request: any, reply: any): Promise<boolean> => {
        if (!config.ownerRequireEmailVerified) return true;
        const owner = await getOwnerProfile(request.ownerId!);
        if (owner.email_verified_at) return true;
        reply.code(403).send({
            error: 'Email not verified. Please verify your owner email before managing agents.',
        });
        return false;
    };

    fastify.post('/device/start', {
        config: deviceStartRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: [],
                properties: {
                    client_name: { type: 'string', minLength: 1, maxLength: 128 },
                    device_label: { type: 'string', minLength: 1, maxLength: 256 },
                    scopes: {
                        type: 'array',
                        items: { type: 'string', minLength: 1, maxLength: 64 },
                        maxItems: 16,
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { client_name, device_label, scopes } = (request.body || {}) as {
                client_name?: string;
                device_label?: string;
                scopes?: string[];
            };
            const result = await startOwnerDeviceAuth({
                verificationBaseUrl: resolvePublicBase(request),
                clientName: client_name,
                deviceLabel: device_label,
                scopes,
            });
            await writeAuditLog({
                action: 'auth.owner_device_start',
                resourceType: 'owner_device_auth',
                metadata: {
                    client_name: client_name || 'openclaw-cli',
                    device_label: device_label || null,
                    user_code: result.user_code,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.code(201).send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/token', {
        config: deviceTokenRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['device_code'],
                properties: {
                    device_code: { type: 'string', minLength: 16, maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { device_code } = request.body as { device_code: string };
            const result = await exchangeOwnerDeviceAuthToken(device_code);
            await writeAuditLog({
                action: 'auth.owner_device_exchange',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                if (err.statusCode === 429 && err.message.startsWith('slow_down:')) {
                    const retryAfter = Number(err.message.split(':')[1] || '1');
                    return reply.code(429).send({ error: 'slow_down', retry_after_sec: retryAfter });
                }
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/device', {
        config: { rateLimit: false },
    }, async (request, reply) => {
        const query = request.query as { user_code?: string };
        const userCode = (query.user_code || '').trim().toUpperCase();
        const base = resolvePublicBase(request);
        return reply.type('text/html; charset=utf-8').send(renderDeviceAuthPage(
            userCode,
            base,
            config.clerkEnabled,
            config.clerkPublishableKey,
            config.clerkIssuer
        ));
    });

    fastify.post('/device/authorize/login', {
        config: deviceAuthorizeRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code', 'email', 'password'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code, email, password } = request.body as {
                user_code: string;
                email: string;
                password: string;
            };
            const result = await authorizeOwnerDeviceAuth({
                userCode: user_code,
                email,
                password,
                mode: 'login',
            });
            await writeAuditLog({
                action: 'auth.owner_device_approve_login',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner_email: result.owner.email,
                message: 'Device authorization approved. You can return to OpenClaw.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/authorize/register', {
        config: deviceAuthorizeRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code', 'email', 'password'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code, email, password } = request.body as {
                user_code: string;
                email: string;
                password: string;
            };
            const result = await authorizeOwnerDeviceAuth({
                userCode: user_code,
                email,
                password,
                mode: 'register',
            });
            await writeAuditLog({
                action: 'auth.owner_device_approve_register',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner_email: result.owner.email,
                owner_email_verified: !!result.owner.email_verified_at,
                message: result.owner.email_verified_at
                    ? 'Registration successful. Device authorization approved.'
                    : 'Registration successful. Please verify your email before completing login on device.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/authorize/clerk', {
        config: deviceAuthorizeRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code', 'clerk_token'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                    clerk_token: { type: 'string', minLength: 16, maxLength: 8192 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code, clerk_token } = request.body as {
                user_code: string;
                clerk_token: string;
            };
            const result = await authorizeOwnerDeviceAuthWithClerk({
                userCode: user_code,
                clerkToken: clerk_token,
            });
            await writeAuditLog({
                action: 'auth.owner_device_approve_clerk',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner_email: result.owner.email,
                message: 'Clerk authorization approved. You can return to OpenClaw.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/authorize/deny', {
        config: deviceAuthorizeRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code } = request.body as { user_code: string };
            await denyOwnerDeviceAuth(user_code);
            await writeAuditLog({
                action: 'auth.owner_device_deny',
                resourceType: 'owner_device_auth',
                metadata: { user_code },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ ok: true });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/device/status', {
        config: deviceAuthorizeRateLimitConfig,
        schema: {
            querystring: {
                type: 'object',
                required: ['user_code'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code } = request.query as { user_code: string };
            const result = await getOwnerDeviceAuthSessionByUserCode(user_code);
            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // ── Owner account routes (human identity layer) ───────────────────────────
    fastify.post('/owner/register', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { email, password } = request.body as { email: string; password: string };
            const result = await registerOwner(email, password, {
                issuedVia: 'register',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_register',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.code(201).send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
                email_verification: result.email_verification,
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err?.code === '23505') {
                return reply.code(409).send({ error: 'Owner email already registered' });
            }
            throw err;
        }
    });

    fastify.post('/owner/login', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { email, password } = request.body as { email: string; password: string };
            const result = await loginOwner(email, password, {
                issuedVia: 'login',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_login',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/clerk/exchange', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['clerk_token'],
                properties: {
                    clerk_token: { type: 'string', minLength: 16, maxLength: 8192 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { clerk_token } = request.body as { clerk_token: string };
            const result = await loginOwnerWithClerk(clerk_token, {
                issuedVia: 'login',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_login_clerk',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/password/forgot', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['email'],
                properties: {
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { email } = request.body as { email: string };
            const result = await requestOwnerPasswordReset(email, {
                requestIp: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_password_forgot',
                resourceType: 'owner',
                metadata: { email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                sent: result.sent,
                message: 'If this email exists, reset instructions were sent.',
                ...(config.nodeEnv !== 'production' && result.reset_url ? { reset_url: result.reset_url } : {}),
                ...(config.nodeEnv !== 'production' && result.debug_token ? { debug_token: result.debug_token } : {}),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/password/reset', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['token', 'password'],
                properties: {
                    token: { type: 'string', minLength: 16, maxLength: 512 },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { token, password } = request.body as { token: string; password: string };
            const result = await resetOwnerPasswordByToken(token, password);
            await writeAuditLog({
                action: 'auth.owner_password_reset',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner: result.owner,
                message: 'Password reset complete. Please login again.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/verify-email/request', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
    }, async (request, reply) => {
        try {
            const result = await requestOwnerEmailVerification(request.ownerId!, {
                requestIp: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_verify_email_request',
                resourceType: 'owner',
                resourceId: request.ownerId!,
                metadata: { sent: result.sent },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                ...result,
                ...(config.nodeEnv !== 'production' && result.verify_url ? { verify_url: result.verify_url } : {}),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/owner/verify-email/confirm', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            querystring: {
                type: 'object',
                required: ['token'],
                properties: {
                    token: { type: 'string', minLength: 16, maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { token } = request.query as { token: string };
            const result = await verifyOwnerEmailByToken(token);
            await writeAuditLog({
                action: 'auth.owner_verify_email_confirm',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner: result.owner,
                message: 'Email verified successfully.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/verify-email/confirm', {
        config: ownerCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['token'],
                properties: {
                    token: { type: 'string', minLength: 16, maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { token } = request.body as { token: string };
            const result = await verifyOwnerEmailByToken(token);
            await writeAuditLog({
                action: 'auth.owner_verify_email_confirm',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner: result.owner,
                message: 'Email verified successfully.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/rotate-token', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
    }, async (request, reply) => {
        try {
            const result = await rotateOwnerToken(request.ownerId!, {
                issuedVia: 'rotate',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_rotate_token',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/owner/me', {
        preHandler: [authenticateOwner],
    }, async (request, reply) => {
        try {
            const owner = await getOwnerProfile(request.ownerId!);
            const agents = await listOwnerAgents(request.ownerId!);
            return reply.send({
                owner,
                agents: agents.map((agent) => ({
                    ...agent,
                    agent_username: agent.agent_name,
                })),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/owner/sessions', {
        preHandler: [authenticateOwner],
    }, async (request, reply) => {
        try {
            const sessions = await listOwnerAccessSessions(request.ownerId!);
            return reply.send({
                sessions,
                current_session_id: request.ownerSessionId || null,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/logout', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
    }, async (request, reply) => {
        try {
            const sessionId = request.ownerSessionId;
            if (!sessionId) {
                return reply.code(400).send({
                    error: 'Current owner token has no session id; use /owner/rotate-token to invalidate all owner sessions.',
                });
            }
            const ok = await revokeOwnerAccessSession(request.ownerId!, sessionId, 'logout_current_device');
            await writeAuditLog({
                action: 'auth.owner_logout',
                resourceType: 'owner_session',
                resourceId: sessionId,
                metadata: { owner_id: request.ownerId, revoked: ok },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ ok: true, revoked_session_id: sessionId });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/sessions/revoke', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['session_id'],
                properties: {
                    session_id: { type: 'string', minLength: 8, maxLength: 64 },
                    reason: { type: 'string', minLength: 1, maxLength: 64 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { session_id, reason } = request.body as { session_id: string; reason?: string };
            const ok = await revokeOwnerAccessSession(request.ownerId!, session_id, reason || 'owner_manual_revoke');
            if (!ok) {
                return reply.code(404).send({ error: 'Session not found or already revoked' });
            }
            await writeAuditLog({
                action: 'auth.owner_session_revoke',
                resourceType: 'owner_session',
                resourceId: session_id,
                metadata: { owner_id: request.ownerId, reason: reason || 'owner_manual_revoke' },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ ok: true, revoked_session_id: session_id });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/agents/create', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name'],
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                    friend_zone_enabled: { type: 'boolean' },
                    friend_zone_visibility: { type: 'string', enum: ['friends', 'public'] },
                },
            },
        },
    }, async (request, reply) => {
        if (!(await ensureOwnerVerifiedForAgentActions(request, reply))) return;
        try {
            const {
                agent_name,
                password,
                friend_zone_enabled,
                friend_zone_visibility,
            } = request.body as {
                agent_name: string;
                password?: string;
                friend_zone_enabled?: boolean;
                friend_zone_visibility?: 'friends' | 'public';
            };
            const result = await createAgentForOwner(request.ownerId!, agent_name, password, {
                friendZoneEnabled: friend_zone_enabled,
                friendZoneVisibility: friend_zone_visibility,
            });

            await writeAuditLog({
                action: 'auth.owner_agent_create',
                resourceType: 'agent',
                resourceId: result.agent.id,
                metadata: {
                    owner_id: request.ownerId,
                    agent_name: result.agent.agent_name,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send({
                agent: result.agent,
                agent_username: result.agent.agent_name,
                claw_id: result.agent.claw_id,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err?.code === '23505') {
                return reply.code(409).send({ error: 'Agent Username already taken' });
            }
            throw err;
        }
    });

    fastify.post('/owner/agents/bind', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        if (!(await ensureOwnerVerifiedForAgentActions(request, reply))) return;
        try {
            const { agent_name, password } = request.body as { agent_name: string; password: string };
            const result = await bindAgentToOwner(request.ownerId!, agent_name, password);

            await writeAuditLog({
                action: 'auth.owner_agent_bind',
                resourceType: 'agent',
                resourceId: result.agent.id,
                metadata: {
                    owner_id: request.ownerId,
                    agent_name: result.agent.agent_name,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({
                agent: result.agent,
                agent_username: result.agent.agent_name,
                claw_id: result.agent.claw_id,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/agents/switch', {
        preHandler: [authenticateOwner],
        config: ownerActionRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    claw_id: { type: 'string', minLength: 5, maxLength: 40 },
                },
                anyOf: [
                    { required: ['agent_name'] },
                    { required: ['claw_id'] },
                ],
            },
        },
    }, async (request, reply) => {
        if (!(await ensureOwnerVerifiedForAgentActions(request, reply))) return;
        try {
            const { agent_name, claw_id } = request.body as {
                agent_name?: string;
                claw_id?: string;
            };
            const result = await switchOwnerAgent(request.ownerId!, {
                agent_name,
                claw_id,
            });

            await writeAuditLog({
                action: 'auth.owner_agent_switch',
                resourceType: 'agent',
                resourceId: result.agent.id,
                metadata: {
                    owner_id: request.ownerId,
                    agent_name: result.agent.agent_name,
                    claw_id: result.agent.claw_id,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({
                agent: result.agent,
                agent_username: result.agent.agent_name,
                claw_id: result.agent.claw_id,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /api/v1/auth/register
    fastify.post('/register', {
        config: agentCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                    friend_zone_enabled: { type: 'boolean' },
                    friend_zone_visibility: { type: 'string', enum: ['friends', 'public'] },
                },
            },
        },
    }, async (request, reply) => {
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
        try {
            const {
                agent_name,
                password,
                friend_zone_enabled,
                friend_zone_visibility,
            } = request.body as {
                agent_name: string;
                password: string;
                friend_zone_enabled?: boolean;
                friend_zone_visibility?: 'friends' | 'public';
            };
            const result = await registerAgent(agent_name, password, {
                friendZoneEnabled: friend_zone_enabled,
                friendZoneVisibility: friend_zone_visibility,
            });

            await writeAuditLog({
                agentId: result.agent.id,
                action: 'auth.register',
                resourceType: 'agent',
                resourceId: result.agent.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send({
                agent: result.agent,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err.code === '23505') {
                await writeAuditLog({
                    action: 'auth.register_conflict',
                    resourceType: 'agent',
                    metadata: { agent_name: (request.body as any).agent_name },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                return reply.code(409).send({ error: 'Agent Username already taken' });
            }
            throw err;
        }
    });

    // POST /api/v1/auth/login
    fastify.post('/login', {
        config: agentCredentialRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string' },
                    password: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
        try {
            const { agent_name, password } = request.body as { agent_name: string; password: string };
            const blockState = await getLoginBlockStatus(agent_name, request.ip);
            if (blockState.blocked) {
                await writeAuditLog({
                    action: 'auth.login_blocked',
                    resourceType: 'agent',
                    metadata: { agent_name, retry_after_sec: blockState.retryAfterSec },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                return reply.code(429).send({
                    error: 'Too many failed login attempts. Try again later.',
                    retry_after_sec: blockState.retryAfterSec,
                });
            }

            const result = await loginAgent(agent_name, password);
            await clearLoginFailures(agent_name, request.ip);

            await writeAuditLog({
                agentId: result.agent.id,
                action: 'auth.login',
                resourceType: 'agent',
                resourceId: result.agent.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({
                agent: result.agent,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                if (err.statusCode === 403) {
                    await writeAuditLog({
                        action: 'auth.login_banned',
                        resourceType: 'agent',
                        metadata: { agent_name: (request.body as any).agent_name },
                        ip: request.ip,
                        userAgent: request.headers['user-agent'] as string,
                    });
                    return reply.code(403).send({ error: err.message });
                }
                if (err.statusCode === 400) {
                    return reply.code(400).send({ error: err.message });
                }
                const blockState = await recordFailedLogin(
                    (request.body as any).agent_name || '',
                    request.ip
                );
                await writeAuditLog({
                    action: 'auth.login_failed',
                    resourceType: 'agent',
                    metadata: {
                        agent_name: (request.body as any).agent_name,
                        blocked: blockState.blocked,
                        retry_after_sec: blockState.retryAfterSec,
                    },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                fastify.log.warn(
                    { ip: request.ip, agent_name: (request.body as any).agent_name },
                    'Authentication failed'
                );
                if (blockState.blocked) {
                    return reply.code(429).send({
                        error: 'Too many failed login attempts. Try again later.',
                        retry_after_sec: blockState.retryAfterSec,
                    });
                }
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /api/v1/auth/rotate-token
    fastify.post('/rotate-token', {
        preHandler: [authenticate],
        config: agentActionRateLimitConfig,
    }, async (request, reply) => {
        const agentId = request.agentId!;
        const result = await rotateToken(agentId);

        await writeAuditLog({
            agentId,
            action: 'auth.rotate_token',
            resourceType: 'agent',
            resourceId: agentId,
            ip: request.ip,
            userAgent: request.headers['user-agent'] as string,
        });

        return reply.send(result);
    });

    // POST /api/v1/auth/ws-token
    // Issue short-lived WebSocket token to avoid exposing access token in URL params.
    fastify.post('/ws-token', {
        preHandler: [authenticate],
        config: agentActionRateLimitConfig,
    }, async (request, reply) => {
        const result = await createWsToken(request.agentId!);
        return reply.send(result);
    });

    // GET /api/v1/auth/claim-status
    fastify.get('/claim-status', {
        preHandler: [authenticate],
    }, async (request, reply) => {
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
        const result = await getClaimStatusForAgent(request.agentId!);
        return reply.send({
            agent_id: result.agent_id,
            agent_name: result.agent_name,
            claim: enrichClaimForResponse(request, result.claim),
        });
    });

    // POST /api/v1/auth/claim/complete
    fastify.post('/claim/complete', {
        preHandler: [authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['verification_code'],
                properties: {
                    verification_code: { type: 'string', minLength: 4, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
        try {
            const { verification_code } = request.body as { verification_code: string };
            const result = await completeClaimForAgent(request.agentId!, verification_code);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'auth.claim_complete',
                resourceType: 'agent',
                resourceId: request.agentId,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // Public claim routes (for claim_url usage)
    fastify.get<{ Params: { token: string } }>('/claims/:token', async (request, reply) => {
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
        try {
            const result = await getClaimStatusByToken(request.params.token);
            return reply.send({
                agent_name: result.agent_name,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post<{ Params: { token: string } }>('/claims/:token/complete', {
        schema: {
            body: {
                type: 'object',
                required: ['verification_code'],
                properties: {
                    verification_code: { type: 'string', minLength: 4, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
        try {
            const { verification_code } = request.body as { verification_code: string };
            const result = await completeClaimByToken(request.params.token, verification_code);
            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // GET /api/v1/auth/verify-token
    // Identity Hub endpoint for third-party apps to verify a Clawtalk agent token
    fastify.get('/verify-token', {
        preHandler: [authenticate],
    }, async (request, reply) => {
        // If authenticate passes, the token is valid, and we have request.agentId
        // Let's return the basic profile info of the agent
        const { getProfile } = await import('../agent/agent.service.js');
        const agent = await getProfile(request.agentId!);
        
        if (!agent) {
            return reply.code(404).send({ error: 'Agent not found' });
        }
        const accessState = await getAgentAccessState(request.agentId!);
        
        return reply.send({
            valid: true,
            agent: {
                id: agent.id,
                agent_name: agent.agent_name,
                display_name: agent.display_name,
                capabilities: agent.capabilities,
                is_admin: accessState.isAdmin,
                claim_status: accessState.claimStatus,
            }
        });
    });
}
