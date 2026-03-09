/**
 * Cloudflare Worker: Restricted CORS proxy + GitHub OAuth Web Flow.
 *
 * SECURITY: The proxy ONLY allows the specific GitHub API operations
 * needed by Wiki3.ai Sync. All other routes are blocked.
 *
 * Routes:
 *   /proxy/*           → Restricted proxy (see ALLOWED_ROUTES below)
 *   /oauth/authorize    → Redirects to GitHub OAuth (web flow)
 *   /oauth/callback     → Handles GitHub callback, returns token via postMessage
 *   /oauth/status       → Health check
 *
 * Allowed proxy operations:
 *   Pull (git smart HTTP):
 *     GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack
 *     POST /<owner>/<repo>.git/git-upload-pack
 *   Push (Git Data API):
 *     GET   /repos/<o>/<r>/git/ref/<ref>
 *     GET   /repos/<o>/<r>/git/refs/<prefix>
 *     GET   /repos/<o>/<r>/git/trees/<sha>
 *     GET   /repos/<o>/<r>/git/commits/<sha>
 *     POST  /repos/<o>/<r>/git/blobs
 *     POST  /repos/<o>/<r>/git/trees
 *     POST  /repos/<o>/<r>/git/commits
 *     POST  /repos/<o>/<r>/git/refs
 *     PATCH /repos/<o>/<r>/git/refs/<ref>
 *
 * Blocked: DELETE, repo admin, user API, workflows, issues, etc.
 */

export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGINS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    // ── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }), origin, env);
    }

    try {
      // ── Routing ─────────────────────────────────────────────────────
      if (url.pathname.startsWith('/proxy/')) {
        return corsResponse(await handleProxy(request, url), origin, env);
      }
      if (url.pathname === '/oauth/authorize') {
        return handleOAuthAuthorize(url, env);
      }
      if (url.pathname === '/oauth/callback') {
        return await handleOAuthCallback(url, env);
      }
      if (url.pathname === '/oauth/status') {
        return corsResponse(
          jsonResponse({ ok: true, hasClientId: !!env.GITHUB_CLIENT_ID }),
          origin,
          env
        );
      }

      return corsResponse(
        jsonResponse({ error: 'Not found' }, 404),
        origin,
        env
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return corsResponse(
        jsonResponse({ error: message }, 500),
        origin,
        env
      );
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Route allowlist — only these GitHub API calls are proxied
// ═══════════════════════════════════════════════════════════════════════

/** Allowed API routes on api.github.com (method + path regex). */
const ALLOWED_API_ROUTES: Array<{ method: string; pattern: RegExp; desc: string }> = [
  // Read refs (singular and plural forms)
  { method: 'GET',   pattern: /^\/repos\/[^/]+\/[^/]+\/git\/refs?(\/|$)/, desc: 'read ref(s)' },
  // Read tree (recursive metadata, no blob content)
  { method: 'GET',   pattern: /^\/repos\/[^/]+\/[^/]+\/git\/trees\/[a-f0-9]+$/, desc: 'read tree' },
  // Read commit (to get tree SHA from commit)
  { method: 'GET',   pattern: /^\/repos\/[^/]+\/[^/]+\/git\/commits\/[a-f0-9]+$/, desc: 'read commit' },
  // Create blob (upload file content)
  { method: 'POST',  pattern: /^\/repos\/[^/]+\/[^/]+\/git\/blobs$/, desc: 'create blob' },
  // Create tree
  { method: 'POST',  pattern: /^\/repos\/[^/]+\/[^/]+\/git\/trees$/, desc: 'create tree' },
  // Create commit
  { method: 'POST',  pattern: /^\/repos\/[^/]+\/[^/]+\/git\/commits$/, desc: 'create commit' },
  // Create ref (new branch)
  { method: 'POST',  pattern: /^\/repos\/[^/]+\/[^/]+\/git\/refs$/, desc: 'create ref' },
  // Update ref (advance branch pointer)
  { method: 'PATCH', pattern: /^\/repos\/[^/]+\/[^/]+\/git\/refs\//, desc: 'update ref' },
];

/**
 * Check whether a proxy request is allowed.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
function isAllowedProxyRoute(
  method: string,
  targetUrl: string
): { allowed: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { allowed: false, reason: 'Invalid target URL' };
  }

  const host = parsed.hostname;
  const path = parsed.pathname;

  // ── github.com: git smart HTTP (clone/pull only) ────────────────
  if (host === 'github.com') {
    // Discovery: info/refs (only git-upload-pack, NOT git-receive-pack)
    if (method === 'GET' && /^\/[^/]+\/[^/]+\.git\/info\/refs$/.test(path)) {
      const service = parsed.searchParams.get('service');
      if (service === 'git-upload-pack') {
        return { allowed: true };
      }
      return { allowed: false, reason: `Blocked git service: ${service}` };
    }
    // Pack negotiation (clone/fetch — read only)
    if (method === 'POST' && /^\/[^/]+\/[^/]+\.git\/git-upload-pack$/.test(path)) {
      return { allowed: true };
    }
    // Block everything else on github.com (including git-receive-pack)
    return { allowed: false, reason: `Blocked: ${method} github.com${path}` };
  }

  // ── api.github.com: only allowlisted Git Data API routes ────────
  if (host === 'api.github.com') {
    for (const route of ALLOWED_API_ROUTES) {
      if (route.method === method && route.pattern.test(path)) {
        return { allowed: true };
      }
    }
    return { allowed: false, reason: `Blocked API route: ${method} ${path}` };
  }

  return { allowed: false, reason: `Blocked host: ${host}` };
}

// ═══════════════════════════════════════════════════════════════════════
// Restricted CORS Proxy
// ═══════════════════════════════════════════════════════════════════════

/**
 * Proxy a request to GitHub. Only allowed routes are forwarded.
 *
 * Path formats:
 *   /proxy/<owner>/<repo>.git/...       → https://github.com/<owner>/<repo>.git/...
 *   /proxy/https://api.github.com/...   → https://api.github.com/...
 */
async function handleProxy(request: Request, url: URL): Promise<Response> {
  const rawPath = url.pathname.slice('/proxy/'.length);
  if (!rawPath) {
    return jsonResponse({ error: 'Missing path after /proxy/' }, 400);
  }

  // Determine target URL
  let targetUrl: string;
  if (rawPath.startsWith('https://')) {
    const parsed = new URL(rawPath + url.search);
    const host = parsed.hostname;
    if (host !== 'github.com' && host !== 'api.github.com') {
      return jsonResponse(
        { error: `Proxy only supports github.com and api.github.com, got ${host}` },
        403
      );
    }
    targetUrl = rawPath + url.search;
  } else {
    targetUrl = `https://github.com/${rawPath}${url.search}`;
  }

  // ── Route allowlist check ───────────────────────────────────────
  const check = isAllowedProxyRoute(request.method, targetUrl);
  if (!check.allowed) {
    return jsonResponse({ error: check.reason }, 403);
  }

  // Forward relevant headers
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'origin' ||
      lower === 'referer' ||
      lower === 'cf-connecting-ip' ||
      lower === 'cf-ray' ||
      lower.startsWith('cf-') ||
      lower.startsWith('x-forwarded')
    ) {
      continue;
    }
    forwardHeaders.set(key, value);
  }

  if (!forwardHeaders.has('User-Agent')) {
    forwardHeaders.set('User-Agent', 'wiki3-ai-sync-proxy/0.2');
  }

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: forwardHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD'
      ? request.body
      : undefined,
    redirect: 'follow',
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('set-cookie');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// GitHub OAuth Web Flow (popup-based)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Start the OAuth web flow by redirecting to GitHub.
 *
 * GET /oauth/authorize?nonce=<nonce>&return_origin=<origin>
 *
 * The nonce is echoed back via postMessage so the client can verify
 * the response came from its own request (prevents CSRF).
 */
function handleOAuthAuthorize(url: URL, env: Env): Response {
  const nonce = url.searchParams.get('nonce');
  const returnOrigin = url.searchParams.get('return_origin') || '';

  if (!nonce) {
    return htmlResponse('<h1>Error</h1><p>Missing nonce parameter.</p>', 400);
  }
  if (!env.GITHUB_CLIENT_ID) {
    return htmlResponse('<h1>Error</h1><p>OAuth not configured on this worker.</p>', 500);
  }
  if (!isAllowedOrigin(returnOrigin, env)) {
    return htmlResponse('<h1>Error</h1><p>Origin not allowed.</p>', 403);
  }

  // Encode nonce + origin in state (base64 JSON)
  const state = btoa(JSON.stringify({ nonce, origin: returnOrigin }));
  const workerOrigin = url.origin;
  const redirectUri = `${workerOrigin}/oauth/callback`;

  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set('redirect_uri', redirectUri);
  githubUrl.searchParams.set('scope', 'public_repo');
  githubUrl.searchParams.set('state', state);

  return Response.redirect(githubUrl.toString(), 302);
}

/**
 * Handle the OAuth callback from GitHub.
 *
 * GET /oauth/callback?code=<code>&state=<state>
 *
 * Exchanges the code for a token, then returns an HTML page that
 * sends the token back to the opener window via postMessage.
 */
async function handleOAuthCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // GitHub sends error= if the user denied access
  if (error) {
    const desc = url.searchParams.get('error_description') || error;
    return htmlResponse(
      `<h1>Authorization Denied</h1><p>${escapeHtml(desc)}</p>
       <p>You can close this window.</p>`,
      400
    );
  }

  if (!code || !stateParam) {
    return htmlResponse('<h1>Error</h1><p>Missing code or state parameter.</p>', 400);
  }

  // Decode and validate state
  let state: { nonce: string; origin: string };
  try {
    state = JSON.parse(atob(stateParam));
  } catch {
    return htmlResponse('<h1>Error</h1><p>Invalid state parameter.</p>', 400);
  }

  if (!isAllowedOrigin(state.origin, env)) {
    return htmlResponse('<h1>Error</h1><p>Origin not allowed.</p>', 403);
  }

  // Exchange code for access token
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenResp.json() as Record<string, string>;

  if (tokenData.error) {
    return htmlResponse(
      `<h1>OAuth Error</h1><p>${escapeHtml(tokenData.error_description || tokenData.error)}</p>
       <p>You can close this window.</p>`,
      400
    );
  }

  // Return HTML that sends the token to the opener via postMessage
  const html = `<!DOCTYPE html>
<html><head><title>Wiki3.ai Sync</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif;
         display: flex; align-items: center; justify-content: center;
         height: 100vh; margin: 0; background: #f6f8fa; }
  .card { background: white; padding: 32px; border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.12); text-align: center; }
</style></head>
<body><div class="card">
  <h2>Logged in!</h2>
  <p id="status">Sending token to Wiki3.ai Sync&hellip;</p>
</div>
<script>
  (function() {
    var token = ${JSON.stringify(tokenData.access_token)};
    var nonce = ${JSON.stringify(state.nonce)};
    var origin = ${JSON.stringify(state.origin)};
    if (window.opener) {
      window.opener.postMessage(
        { type: 'wiki3-oauth', token: token, nonce: nonce },
        origin
      );
      document.getElementById('status').textContent =
        'Done! This window will close automatically.';
      setTimeout(function() { window.close(); }, 800);
    } else {
      document.getElementById('status').textContent =
        'Could not communicate with the parent window. ' +
        'Please close this tab and try again.';
    }
  })();
</script>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html><head><title>Wiki3.ai Sync</title>
<style>body{font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;}</style>
</head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Check if an origin is in the ALLOWED_ORIGINS list. */
function isAllowedOrigin(origin: string, env: Env): boolean {
  const allowed = env.ALLOWED_ORIGINS ?? '*';
  if (allowed === '*') return true;
  return allowed.split(',').map(s => s.trim()).includes(origin);
}

/**
 * Add CORS headers to a response. Only allows configured origins.
 */
function corsResponse(response: Response, origin: string, env: Env): Response {
  if (!isAllowedOrigin(origin, env)) {
    return response;
  }

  const allowOrigin = (env.ALLOWED_ORIGINS ?? '*') === '*' ? '*' : origin;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept, X-Requested-With, X-GitHub-Api-Version'
  );
  headers.set('Access-Control-Expose-Headers', '*');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
