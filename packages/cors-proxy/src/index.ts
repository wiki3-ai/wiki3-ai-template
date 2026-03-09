/**
 * Cloudflare Worker: CORS proxy for isomorphic-git + GitHub OAuth Device Flow.
 *
 * Routes:
 *   /proxy/*          → Proxies requests to github.com, adding CORS headers.
 *                       isomorphic-git sends requests like:
 *                         GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack
 *                         POST /<owner>/<repo>.git/git-upload-pack
 *                         POST /<owner>/<repo>.git/git-receive-pack
 *
 *   /oauth/device      → POST: Start GitHub Device Flow (returns user_code, verification_uri)
 *   /oauth/token        → POST: Poll for access token (exchanges device_code for token)
 *   /oauth/status       → GET:  Health check
 *
 * Environment variables (set as secrets or in wrangler.toml):
 *   GITHUB_CLIENT_ID     — OAuth App client ID
 *   GITHUB_CLIENT_SECRET — OAuth App client secret
 *   ALLOWED_ORIGINS      — Comma-separated allowed origins, or "*"
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
      if (url.pathname === '/oauth/device') {
        return corsResponse(await handleDeviceCode(request, env), origin, env);
      }
      if (url.pathname === '/oauth/token') {
        return corsResponse(await handleDeviceToken(request, env), origin, env);
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
// Git CORS Proxy
// ═══════════════════════════════════════════════════════════════════════

/**
 * Proxy a request to GitHub, preserving method, headers, and body.
 *
 * Supported path formats:
 *   /proxy/<owner>/<repo>.git/...   → https://github.com/<owner>/<repo>.git/...
 *   /proxy/https://api.github.com/... → https://api.github.com/...
 *   /proxy/https://github.com/...     → https://github.com/...
 *
 * Only github.com and api.github.com are allowed as targets.
 */
async function handleProxy(request: Request, url: URL): Promise<Response> {
  // Strip "/proxy/" prefix to get the target path
  const rawPath = url.pathname.slice('/proxy/'.length);
  if (!rawPath) {
    return jsonResponse({ error: 'Missing path after /proxy/' }, 400);
  }

  // Determine the target URL
  let targetUrl: string;
  if (rawPath.startsWith('https://')) {
    // Full URL form: /proxy/https://api.github.com/repos/...
    const parsed = new URL(rawPath + url.search);
    const host = parsed.hostname;
    if (host !== 'github.com' && host !== 'api.github.com') {
      return jsonResponse({ error: `Proxy only supports github.com and api.github.com, got ${host}` }, 403);
    }
    targetUrl = rawPath + url.search;
  } else {
    // Short form: /proxy/<owner>/<repo>.git/... → github.com
    targetUrl = `https://github.com/${rawPath}${url.search}`;
  }

  // Forward relevant headers, skip host/origin/referer
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

  // Always set a User-Agent (GitHub requires it)
  if (!forwardHeaders.has('User-Agent')) {
    forwardHeaders.set('User-Agent', 'wiki3-ai-sync-proxy/0.1');
  }

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: forwardHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD'
      ? request.body
      : undefined,
    redirect: 'follow',
  });

  // Clone response so we can modify headers
  const responseHeaders = new Headers(response.headers);

  // Remove headers that shouldn't be forwarded back
  responseHeaders.delete('set-cookie');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// GitHub OAuth Device Flow
// ═══════════════════════════════════════════════════════════════════════

/**
 * Step 1: Request a device code from GitHub.
 * POST /oauth/device
 * Body: { "scope": "public_repo" }   (optional, defaults to "public_repo")
 *
 * Returns: { device_code, user_code, verification_uri, expires_in, interval }
 */
async function handleDeviceCode(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  if (!env.GITHUB_CLIENT_ID) {
    return jsonResponse({ error: 'OAuth not configured (missing GITHUB_CLIENT_ID)' }, 500);
  }

  let scope = 'public_repo';
  try {
    const body = await request.json() as Record<string, string>;
    if (body.scope) scope = body.scope;
  } catch {
    // use default scope
  }

  const ghResponse = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      scope,
    }),
  });

  const data = await ghResponse.json();
  return jsonResponse(data, ghResponse.status);
}

/**
 * Step 2: Poll for the access token.
 * POST /oauth/token
 * Body: { "device_code": "..." }
 *
 * Returns: { access_token, token_type, scope } on success,
 *          { error: "authorization_pending" } while waiting,
 *          { error: "..." } on failure.
 */
async function handleDeviceToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return jsonResponse(
      { error: 'OAuth not configured (missing client ID or secret)' },
      500
    );
  }

  let deviceCode = '';
  try {
    const body = await request.json() as Record<string, string>;
    deviceCode = body.device_code ?? '';
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (!deviceCode) {
    return jsonResponse({ error: 'Missing device_code' }, 400);
  }

  const ghResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  const data = await ghResponse.json();
  return jsonResponse(data, ghResponse.status);
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

/**
 * Add CORS headers to a response. Only allows configured origins.
 */
function corsResponse(response: Response, origin: string, env: Env): Response {
  const allowed = env.ALLOWED_ORIGINS ?? '*';
  let allowOrigin = '';

  if (allowed === '*') {
    allowOrigin = '*';
  } else {
    const origins = allowed.split(',').map(s => s.trim());
    if (origins.includes(origin)) {
      allowOrigin = origin;
    }
  }

  if (!allowOrigin) {
    // Origin not allowed — return response without CORS headers
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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
