/**
 * GitHub OAuth Web Flow for browser-based authentication.
 *
 * Uses the standard OAuth authorization code flow via a popup window:
 *   1. Extension opens popup → proxy /oauth/authorize → GitHub authorize page
 *   2. User clicks "Authorize" on GitHub
 *   3. GitHub redirects to proxy /oauth/callback with auth code
 *   4. Proxy exchanges code for token, sends it back via postMessage
 *   5. Extension receives token in the message listener
 *
 * Security:
 *   - postMessage is scoped to the allowed origin (prevents leakage)
 *   - nonce ties the response to the request (prevents CSRF)
 *   - Token exchange happens server-side (client_secret never exposed)
 */

/**
 * Start the OAuth web flow in a popup window.
 *
 * Opens a popup to the proxy's /oauth/authorize endpoint, which redirects
 * to GitHub. After the user authorizes, the popup sends the token back
 * via postMessage and closes automatically.
 *
 * @param proxyUrl - Base URL of the CORS proxy worker
 * @returns The access token, or rejects if cancelled/blocked/failed
 */
export function startOAuthPopup(proxyUrl: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Generate a nonce to tie request → response
    const nonce = generateNonce();
    const origin = window.location.origin;

    const authUrl =
      `${proxyUrl}/oauth/authorize` +
      `?nonce=${encodeURIComponent(nonce)}` +
      `&return_origin=${encodeURIComponent(origin)}`;

    // Open popup immediately (preserves user-gesture for popup blockers)
    const popup = window.open(
      authUrl,
      'wiki3-oauth',
      'width=600,height=700,popup=yes'
    );

    if (!popup) {
      reject(
        new Error(
          'Popup blocked by the browser. Please allow popups for this site and try again.'
        )
      );
      return;
    }

    let settled = false;

    // Listen for the token via postMessage from the callback page
    const onMessage = (event: MessageEvent) => {
      // Verify the message comes from the proxy worker
      const proxyOrigin = new URL(proxyUrl).origin;
      if (event.origin !== proxyOrigin) return;
      if (event.data?.type !== 'wiki3-oauth') return;
      if (event.data?.nonce !== nonce) return;

      cleanup();

      if (event.data.token) {
        settled = true;
        resolve(event.data.token);
      } else {
        settled = true;
        reject(new Error('OAuth flow did not return a token.'));
      }
    };

    window.addEventListener('message', onMessage);

    // Watch for the popup being closed without completing auth
    const checkClosed = setInterval(() => {
      if (popup.closed && !settled) {
        cleanup();
        settled = true;
        reject(new Error('Login cancelled (popup closed).'));
      }
    }, 500);

    function cleanup() {
      window.removeEventListener('message', onMessage);
      clearInterval(checkClosed);
    }
  });
}

/**
 * Get a cached token from sessionStorage, or null.
 */
export function getCachedToken(): string | null {
  if (typeof sessionStorage !== 'undefined') {
    return sessionStorage.getItem('jl-deploy-token') || null;
  }
  return null;
}

/**
 * Cache a token in sessionStorage (cleared when tab closes).
 */
export function cacheToken(token: string): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('jl-deploy-token', token);
  }
}

/** Generate a random nonce string for CSRF protection. */
function generateNonce(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
