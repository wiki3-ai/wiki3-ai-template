/**
 * CORS-proxy-aware HTTP client for isomorphic-git.
 *
 * Wraps the standard isomorphic-git/http/web module to route
 * requests through a Cloudflare Worker proxy, avoiding browser
 * CORS restrictions when talking to github.com.
 *
 * Usage:
 *   import { makeProxyHttp } from './proxy-http';
 *   const http = makeProxyHttp('https://my-worker.workers.dev');
 *   await git.clone({ fs, http, ... });
 */

import _http from 'isomorphic-git/http/web';

/**
 * Create an isomorphic-git compatible HTTP client that routes
 * github.com requests through the CORS proxy.
 *
 * @param proxyBaseUrl - The base URL of the proxy worker,
 *                       e.g. "https://wiki3-ai-sync-proxy.you.workers.dev"
 *                       If empty/null, requests go directly (for testing).
 */
export function makeProxyHttp(proxyBaseUrl?: string | null) {
  return {
    async request(config: { url: string; [key: string]: any }) {
      let { url } = config;

      // Rewrite github.com URLs to go through the proxy
      if (proxyBaseUrl && url.startsWith('https://github.com/')) {
        const path = url.slice('https://github.com/'.length);
        url = `${proxyBaseUrl.replace(/\/+$/, '')}/proxy/${path}`;
      }

      return _http.request({ ...config, url });
    },
  };
}

/** Default CORS proxy URL for the Wiki3.ai Sync worker. */
const DEFAULT_PROXY_URL = 'https://wiki3-ai-sync-proxy.jim-2ad.workers.dev';

/**
 * The proxy URL to use. Checks localStorage override, falls back to the
 * built-in default so users never need to configure it.
 */
export function getProxyUrl(): string {
  if (typeof localStorage !== 'undefined') {
    const custom = localStorage.getItem('jl-deploy-proxy');
    if (custom) return custom;
  }
  return DEFAULT_PROXY_URL;
}

/**
 * Auto-detect the GitHub repo URL from the current site's location.
 * Works for GitHub Pages sites: https://<org>.github.io/<repo>/
 * Returns empty string if detection fails.
 */
export function detectRepoUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const { hostname, pathname } = window.location;
    // Match <org>.github.io
    const m = hostname.match(/^([^.]+)\.github\.io$/);
    if (m) {
      const org = m[1];
      // The first path segment is the repo name
      const segments = pathname.split('/').filter(Boolean);
      const repo = segments[0];
      if (repo) {
        return `https://github.com/${org}/${repo}`;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * Get the default repo URL: check localStorage, then auto-detect from site URL.
 */
export function getDefaultRepoUrl(): string {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('jl-deploy-repo');
    if (saved) return saved;
  }
  return detectRepoUrl();
}
