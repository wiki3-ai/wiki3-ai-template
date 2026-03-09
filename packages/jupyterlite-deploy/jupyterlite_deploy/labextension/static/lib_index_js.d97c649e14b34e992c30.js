"use strict";
(self["webpackChunkjupyterlite_deploy"] = self["webpackChunkjupyterlite_deploy"] || []).push([["lib_index_js"],{

/***/ "./lib/deploy.js"
/*!***********************!*\
  !*** ./lib/deploy.js ***!
  \***********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   collectContentsFiles: () => (/* binding */ collectContentsFiles),
/* harmony export */   deployToGitHub: () => (/* binding */ deployToGitHub),
/* harmony export */   syncFromRepo: () => (/* binding */ syncFromRepo)
/* harmony export */ });
/* harmony import */ var isomorphic_git__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! isomorphic-git */ "webpack/sharing/consume/default/isomorphic-git/isomorphic-git");
/* harmony import */ var _proxy_http__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./proxy-http */ "./lib/proxy-http.js");
/* harmony import */ var _memfs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./memfs */ "./lib/memfs.js");
/**
 * Core push logic: uses GitHub's Git Data API (Trees/Blobs/Commits/Refs)
 * to update only the files/ subdirectory without downloading existing
 * site content. Zero download of blobs — only uploads new/changed files.
 */



// ── GitHub API helpers ──────────────────────────────────────────────
/** Parse "owner" and "repo" from a GitHub URL. */
function parseGitHubUrl(repoUrl) {
    // Handle https://github.com/owner/repo.git or https://github.com/owner/repo
    const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!m) {
        throw new Error(`Cannot parse owner/repo from URL: ${repoUrl}`);
    }
    return { owner: m[1], repo: m[2] };
}
/** Build the base API URL, routing through the CORS proxy if provided. */
function apiUrl(proxyUrl, path) {
    const base = `https://api.github.com${path}`;
    if (proxyUrl) {
        return `${proxyUrl}/proxy/${base}`;
    }
    return base;
}
/** Authenticated fetch to GitHub API. */
async function ghFetch(url, token, options = {}) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {}),
    };
    const resp = await fetch(url, { ...options, headers });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GitHub API error (${resp.status}): ${body}`);
    }
    return resp;
}
/**
 * Push content files to a remote branch using the GitHub Git Data API.
 *
 * This avoids cloning entirely. Instead it:
 *   1. Reads the current branch ref → commit SHA → tree SHA
 *   2. Gets the recursive tree (just SHA references, no blob content)
 *   3. Computes blob SHAs locally, uploads only new/changed blobs
 *   4. Creates a new tree with updated entries under files/
 *   5. Creates a commit and updates the branch ref
 *
 * The only data transferred is the new/changed file content (upload).
 * No existing site content (build/, static/, etc.) is downloaded.
 */
async function deployToGitHub(files, options) {
    const { repoUrl, branch, token, message, authorName, authorEmail, proxyUrl, onProgress, } = options;
    const log = (msg) => onProgress === null || onProgress === void 0 ? void 0 : onProgress(msg);
    const { owner, repo } = parseGitHubUrl(repoUrl);
    const repoPath = `/repos/${owner}/${repo}`;
    // ── 1. Get current branch HEAD ────────────────────────────────────
    log(`Reading ${branch} ref…`);
    let parentCommitSha = null;
    let baseTreeSha = null;
    try {
        const refResp = await ghFetch(apiUrl(proxyUrl, `${repoPath}/git/ref/heads/${branch}`), token);
        const refData = await refResp.json();
        parentCommitSha = refData.object.sha;
        // Get the commit to find its tree
        const commitResp = await ghFetch(apiUrl(proxyUrl, `${repoPath}/git/commits/${parentCommitSha}`), token);
        const commitData = await commitResp.json();
        baseTreeSha = commitData.tree.sha;
        log(`Current HEAD: ${parentCommitSha.slice(0, 8)}, tree: ${baseTreeSha.slice(0, 8)}`);
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('404') || errMsg.includes('Not Found')) {
            log(`Branch "${branch}" does not exist — will create it.`);
        }
        else {
            throw err;
        }
    }
    // ── 2. Get existing tree (SHA references only, no blob content) ───
    let existingTree = [];
    if (baseTreeSha) {
        log('Reading existing tree…');
        const treeResp = await ghFetch(apiUrl(proxyUrl, `${repoPath}/git/trees/${baseTreeSha}?recursive=1`), token);
        const treeData = await treeResp.json();
        existingTree = treeData.tree;
        if (treeData.truncated) {
            log('  Warning: tree was truncated (very large repo)');
        }
        log(`  ${existingTree.length} entries in existing tree`);
    }
    // Build a map of existing file paths → SHA for quick lookup
    const existingBlobShas = new Map();
    for (const entry of existingTree) {
        if (entry.type === 'blob') {
            existingBlobShas.set(entry.path, entry.sha);
        }
    }
    // ── 3. Compute blob SHAs locally, upload only new/changed blobs ───
    log(`Processing ${files.length} content file(s)…`);
    const newTreeEntries = [];
    let uploaded = 0;
    let skipped = 0;
    for (const file of files) {
        const repoPath_ = 'files/' + file.path;
        // Compute the git blob SHA (same algorithm git uses)
        const blobSha = await computeBlobSha(file.content);
        if (existingBlobShas.get(repoPath_) === blobSha) {
            // File unchanged — reuse existing SHA, no upload needed
            skipped++;
            continue;
        }
        // Upload the blob
        const blobResp = await ghFetch(apiUrl(proxyUrl, `${repoPath}/git/blobs`), token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: uint8ArrayToBase64(file.content),
                encoding: 'base64',
            }),
        });
        const blobData = await blobResp.json();
        uploaded++;
        log(`  ↑ files/${file.path} (${formatBytes(file.content.length)})`);
        newTreeEntries.push({
            path: repoPath_,
            mode: '100644',
            type: 'blob',
            sha: blobData.sha,
        });
    }
    if (uploaded === 0) {
        log(`No files changed (${skipped} identical) — nothing to push.`);
        return;
    }
    log(`${uploaded} file(s) uploaded, ${skipped} unchanged.`);
    // ── 4. Create new tree ────────────────────────────────────────────
    log('Creating tree…');
    const treeBody = {
        tree: newTreeEntries,
    };
    if (baseTreeSha) {
        // base_tree preserves all existing entries not listed in `tree`
        treeBody.base_tree = baseTreeSha;
    }
    const newTreeResp = await ghFetch(apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/trees`), token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(treeBody),
    });
    const newTreeData = await newTreeResp.json();
    log(`  New tree: ${newTreeData.sha.slice(0, 8)}`);
    // ── 5. Create commit ──────────────────────────────────────────────
    log('Creating commit…');
    const now = new Date().toISOString();
    const commitBody = {
        message,
        tree: newTreeData.sha,
        author: {
            name: authorName,
            email: authorEmail,
            date: now,
        },
    };
    if (parentCommitSha) {
        commitBody.parents = [parentCommitSha];
    }
    const commitResp = await ghFetch(apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/commits`), token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commitBody),
    });
    const commitData = await commitResp.json();
    log(`  Commit: ${commitData.sha.slice(0, 8)}`);
    // ── 6. Update branch ref ──────────────────────────────────────────
    log(`Updating ${branch}…`);
    if (parentCommitSha) {
        // Branch exists — update it
        await ghFetch(apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/refs/heads/${branch}`), token, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha: commitData.sha }),
        });
    }
    else {
        // Branch doesn't exist — create it
        await ghFetch(apiUrl(proxyUrl, `/repos/${owner}/${repo}/git/refs`), token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ref: `refs/heads/${branch}`,
                sha: commitData.sha,
            }),
        });
    }
    log('Push complete ✓');
}
// ── Blob SHA computation ────────────────────────────────────────────
/**
 * Compute the git blob SHA-1 for content.
 * Git hashes: "blob <size>\0<content>"
 */
async function computeBlobSha(content) {
    const header = new TextEncoder().encode(`blob ${content.length}\0`);
    const full = new Uint8Array(header.length + content.length);
    full.set(header, 0);
    full.set(content, header.length);
    // Use Web Crypto API (available in browsers and workers)
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const hashBuffer = await crypto.subtle.digest('SHA-1', full);
        return Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    // Fallback: use isomorphic-git's internal SHA function if available
    // This shouldn't happen in browsers but provides a safety net
    throw new Error('SHA-1 not available (no crypto.subtle)');
}
/** Convert Uint8Array to base64 string. */
function uint8ArrayToBase64(bytes) {
    // btoa works in browsers; for large files, process in chunks
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        for (let j = 0; j < chunk.length; j++) {
            binary += String.fromCharCode(chunk[j]);
        }
    }
    return btoa(binary);
}
/** Format bytes as human-readable string. */
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Recursively enumerate all files under `dir` in the given MemFS,
 * returning paths relative to `dir`.
 */
async function listAllFiles(fs, dir, prefix) {
    const entries = (await fs.promises.readdir(prefix ? dir + '/' + prefix : dir));
    const result = [];
    for (const name of entries) {
        // Skip .git internals — GitHub rejects trees containing '.git'
        if (name === '.git')
            continue;
        const rel = prefix ? prefix + '/' + name : name;
        const full = dir + '/' + rel;
        const stat = (await fs.promises.stat(full));
        if (stat.isDirectory()) {
            result.push(...(await listAllFiles(fs, dir, rel)));
        }
        else {
            result.push(rel);
        }
    }
    return result;
}
/**
 * Collect all files from the JupyterLite Contents API, recursively.
 * Returns IFileEntry[] suitable for `deployToGitHub`.
 */
async function collectContentsFiles(contentsManager, basePath = '') {
    const files = [];
    const model = await contentsManager.get(basePath, { content: true });
    if (model.type === 'directory') {
        const items = model.content;
        for (const item of items) {
            if (item.type === 'directory') {
                const sub = await collectContentsFiles(contentsManager, item.path);
                files.push(...sub);
            }
            else {
                const full = await contentsManager.get(item.path, { content: true });
                const content = encodeContent(full);
                files.push({ path: item.path, content });
            }
        }
    }
    else {
        const content = encodeContent(model);
        files.push({ path: model.path, content });
    }
    return files;
}
/**
 * Convert a Contents model's content to bytes.
 */
function encodeContent(model) {
    const raw = model.content;
    if (model.format === 'base64' && typeof raw === 'string') {
        return Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    }
    if (typeof raw === 'string') {
        return new TextEncoder().encode(raw);
    }
    // JSON content (notebooks)
    return new TextEncoder().encode(JSON.stringify(raw, null, 2) + '\n');
}
/**
 * Pull the latest content files from a remote branch and write them
 * into the JupyterLite Contents API, replacing stale browser-cached versions.
 *
 * For public repos no token is needed.
 */
async function syncFromRepo(contentsManager, options) {
    var _a, _b;
    const { repoUrl, branch, token, contentPath, proxyUrl, onProgress } = options;
    const log = (msg) => onProgress === null || onProgress === void 0 ? void 0 : onProgress(msg);
    const http = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_1__.makeProxyHttp)(proxyUrl);
    const fs = new _memfs__WEBPACK_IMPORTED_MODULE_2__.MemFS();
    const dir = '/repo';
    log('Cloning (shallow) from remote…');
    await isomorphic_git__WEBPACK_IMPORTED_MODULE_0__["default"].clone({
        fs,
        http,
        dir,
        url: repoUrl,
        ref: branch,
        singleBranch: true,
        depth: 1,
        onAuth: token ? () => ({ username: 'x-access-token', password: token }) : undefined,
        onMessage: (msg) => log(`  remote: ${msg}`),
    });
    // List all files from the clone
    const prefix = contentPath ? contentPath.replace(/\/+$/, '') : '';
    const searchDir = prefix ? dir + '/' + prefix : dir;
    let allFiles;
    try {
        allFiles = await listAllFiles(fs, searchDir, '');
    }
    catch (_c) {
        log(`No files found under "${prefix || '/'}".`);
        return { updated: 0, total: 0 };
    }
    // Filter out git internals and .nojekyll
    const contentFiles = allFiles.filter(f => !f.startsWith('.git/') && f !== '.git' && f !== '.nojekyll');
    log(`Found ${contentFiles.length} file(s) in repo.`);
    let updated = 0;
    for (const relPath of contentFiles) {
        const fullPath = searchDir + '/' + relPath;
        const data = (await fs.promises.readFile(fullPath));
        // Determine the target path in the Contents API
        // Strip the contentPath prefix so files land at the root of JupyterLite's FS
        const targetPath = relPath;
        // Determine format and content for the Contents API
        const ext = (_b = (_a = targetPath.split('.').pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== null && _b !== void 0 ? _b : '';
        const isNotebook = ext === 'ipynb';
        const isBinary = [
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg',
            'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'gz',
            'whl', 'pyc', 'so', 'wasm'
        ].includes(ext);
        try {
            // Ensure parent directories exist
            const parts = targetPath.split('/');
            if (parts.length > 1) {
                let cur = '';
                for (let i = 0; i < parts.length - 1; i++) {
                    cur = cur ? cur + '/' + parts[i] : parts[i];
                    try {
                        await contentsManager.get(cur);
                    }
                    catch (_d) {
                        await contentsManager.save(cur, {
                            type: 'directory',
                            name: parts[i],
                            path: cur,
                        });
                    }
                }
            }
            if (isNotebook) {
                // Parse the notebook JSON and save as notebook type
                const text = new TextDecoder().decode(data);
                const nbContent = JSON.parse(text);
                await contentsManager.save(targetPath, {
                    type: 'notebook',
                    format: 'json',
                    content: nbContent,
                });
            }
            else if (isBinary) {
                // Save as base64
                const b64 = btoa(String.fromCharCode(...data));
                await contentsManager.save(targetPath, {
                    type: 'file',
                    format: 'base64',
                    content: b64,
                });
            }
            else {
                // Save as text
                const text = new TextDecoder().decode(data);
                await contentsManager.save(targetPath, {
                    type: 'file',
                    format: 'text',
                    content: text,
                });
            }
            updated++;
            log(`  ✓ ${targetPath}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`  ✗ ${targetPath}: ${msg}`);
        }
    }
    log(`\nSynced ${updated}/${contentFiles.length} file(s).`);
    return { updated, total: contentFiles.length };
}


/***/ },

/***/ "./lib/index.js"
/*!**********************!*\
  !*** ./lib/index.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   "default": () => (__WEBPACK_DEFAULT_EXPORT__)
/* harmony export */ });
/* harmony import */ var buffer__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! buffer */ "webpack/sharing/consume/default/buffer/buffer");
/* harmony import */ var _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @jupyterlab/apputils */ "webpack/sharing/consume/default/@jupyterlab/apputils");
/* harmony import */ var _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__);
/* harmony import */ var _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @lumino/widgets */ "webpack/sharing/consume/default/@lumino/widgets");
/* harmony import */ var _lumino_widgets__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(_lumino_widgets__WEBPACK_IMPORTED_MODULE_2__);
/* harmony import */ var _deploy__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./deploy */ "./lib/deploy.js");
/* harmony import */ var _proxy_http__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./proxy-http */ "./lib/proxy-http.js");
/* harmony import */ var _oauth__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./oauth */ "./lib/oauth.js");
/**
 * jupyterlite-deploy — JupyterLab/JupyterLite extension
 *
 * Adds a "Push to GitHub Pages" command that uses isomorphic-git
 * to push content files to a gh-pages branch.
 */
// Polyfill Buffer for isomorphic-git (webpack 5 doesn't auto-polyfill Node globals)

if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = buffer__WEBPACK_IMPORTED_MODULE_0__.Buffer;
}





/** Command IDs */
const CMD_DEPLOY = 'deploy:gh-pages';
const CMD_SYNC = 'deploy:sync';
const CMD_LOGIN = 'deploy:login';
/**
 * Parse "Name <email>" into { name, email }.
 */
function parseAuthor(raw) {
    const m = raw.match(/^(.+?)\s*<(.+?)>\s*$/);
    if (m) {
        return { name: m[1].trim(), email: m[2].trim() };
    }
    return { name: raw.trim() || 'Deploy', email: 'deploy@example.com' };
}
/**
 * Perform GitHub OAuth login via popup.
 * Opens a popup to the proxy's /oauth/authorize endpoint.
 * Returns the access token on success, or empty string if cancelled/failed.
 */
async function doOAuthLogin(proxyUrl) {
    if (!proxyUrl) {
        await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
            title: 'OAuth Login',
            body: 'CORS Proxy URL is not configured.',
            buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
        });
        return '';
    }
    try {
        const token = await (0,_oauth__WEBPACK_IMPORTED_MODULE_5__.startOAuthPopup)(proxyUrl);
        if (token) {
            (0,_oauth__WEBPACK_IMPORTED_MODULE_5__.cacheToken)(token);
            return token;
        }
    }
    catch (err) {
        const msg = err.message || String(err);
        // Don't show error if the user just closed the popup
        if (!msg.includes('cancelled') && !msg.includes('closed')) {
            await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                title: 'OAuth Error',
                body: msg,
                buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
            });
        }
    }
    return '';
}
/**
 * Ensure we have a valid GitHub token. Returns the cached token or
 * triggers the OAuth web flow (popup) automatically.
 * Returns empty string if the user cancels or an error occurs.
 */
async function ensureToken() {
    // Check session storage first
    const cached = sessionStorage.getItem('jl-deploy-token');
    if (cached)
        return cached;
    // Check the oauth module's in-memory cache
    const oauthCached = (0,_oauth__WEBPACK_IMPORTED_MODULE_5__.getCachedToken)();
    if (oauthCached)
        return oauthCached;
    // No token — trigger OAuth login automatically
    const proxyUrl = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getProxyUrl)();
    const token = await doOAuthLogin(proxyUrl);
    if (token) {
        sessionStorage.setItem('jl-deploy-token', token);
    }
    return token;
}
/**
 * Extension activation.
 */
const plugin = {
    id: 'jupyterlite-deploy:plugin',
    description: 'Push content files to GitHub Pages using isomorphic-git',
    autoStart: true,
    optional: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.ICommandPalette],
    activate: (app, palette) => {
        console.log('jupyterlite-deploy: activated');
        app.commands.addCommand(CMD_DEPLOY, {
            label: 'Wiki3.ai Sync: Push to GitHub Pages',
            caption: 'Push content files to a gh-pages branch',
            execute: async () => {
                var _a;
                // ── 1. Ensure we have a token (auto-login if needed) ─────
                const token = await ensureToken();
                if (!token)
                    return; // user cancelled
                // ── 2. Show lightweight config dialog ────────────────────
                const repoDefault = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getDefaultRepoUrl)();
                const body = document.createElement('div');
                body.classList.add('jl-deploy-dialog');
                body.innerHTML = `
          <label for="jl-deploy-repo">Repository</label>
          <input id="jl-deploy-repo" type="text"
                 placeholder="https://github.com/user/repo"
                 value="${repoDefault}" />

          <label for="jl-deploy-branch">Branch</label>
          <input id="jl-deploy-branch" type="text"
                 value="${localStorage.getItem('jl-deploy-branch') || 'gh-pages'}" />

          <label for="jl-deploy-message">Commit message</label>
          <input id="jl-deploy-message" type="text"
                 value="Update content files" />
        `;
                const dialogResult = await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Push to GitHub Pages',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: body }),
                    buttons: [
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.cancelButton(),
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Push' }),
                    ],
                });
                if (!dialogResult.button.accept)
                    return;
                const repoUrl = body.querySelector('#jl-deploy-repo').value.trim();
                const branch = body.querySelector('#jl-deploy-branch').value.trim() || 'gh-pages';
                const message = body.querySelector('#jl-deploy-message').value.trim() || 'Update content files';
                if (!repoUrl) {
                    void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                        title: 'Push Error',
                        body: 'Repository URL is required.',
                        buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
                    });
                    return;
                }
                // Persist settings for next time
                localStorage.setItem('jl-deploy-repo', repoUrl);
                localStorage.setItem('jl-deploy-branch', branch);
                const proxyUrl = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getProxyUrl)();
                const authorRaw = localStorage.getItem('jl-deploy-author') || 'Wiki3 Bot <deploy@wiki3.ai>';
                const { name: authorName, email: authorEmail } = parseAuthor(authorRaw);
                // ── 3. Collect files + push ──────────────────────────────
                const statusNode = document.createElement('pre');
                statusNode.classList.add('jl-deploy-status');
                statusNode.textContent = 'Collecting files…\n';
                const statusWidget = new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: statusNode });
                void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Pushing…',
                    body: statusWidget,
                    buttons: [], // no user buttons while pushing
                });
                const log = (msg) => {
                    statusNode.textContent += msg + '\n';
                    statusNode.scrollTop = statusNode.scrollHeight;
                };
                try {
                    log('Reading files from Contents API…');
                    const files = await (0,_deploy__WEBPACK_IMPORTED_MODULE_3__.collectContentsFiles)(app.serviceManager.contents);
                    log(`Collected ${files.length} file(s).`);
                    await (0,_deploy__WEBPACK_IMPORTED_MODULE_3__.deployToGitHub)(files, {
                        repoUrl,
                        branch,
                        token,
                        message,
                        authorName,
                        authorEmail,
                        proxyUrl,
                        onProgress: log,
                    });
                    log('\nDone!');
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log(`\nERROR: ${errMsg}`);
                }
                await new Promise(r => setTimeout(r, 300));
                _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.flush();
                // Show final status
                const finalNode = document.createElement('pre');
                finalNode.classList.add('jl-deploy-status');
                finalNode.textContent = (_a = statusNode.textContent) !== null && _a !== void 0 ? _a : '';
                await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Push Result',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: finalNode }),
                    buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Close' })],
                });
            },
        });
        // ── Sync from Repository command ───────────────────────────────
        app.commands.addCommand(CMD_SYNC, {
            label: 'Wiki3.ai Sync: Pull from Repository',
            caption: 'Pull latest content files from a git branch into JupyterLite',
            execute: async () => {
                var _a;
                // ── 1. Ensure we have a token (auto-login if needed) ─────
                // Token is optional for public repos, but try to get one
                const token = await ensureToken();
                // Don't block on missing token — public repos work without it
                // ── 2. Show lightweight config dialog ────────────────────
                const repoDefault = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getDefaultRepoUrl)();
                const syncBody = document.createElement('div');
                syncBody.classList.add('jl-deploy-dialog');
                syncBody.innerHTML = `
          <label for="jl-sync-repo">Repository</label>
          <input id="jl-sync-repo" type="text"
                 placeholder="https://github.com/user/repo"
                 value="${repoDefault}" />

          <label for="jl-sync-branch">Branch</label>
          <input id="jl-sync-branch" type="text"
                 value="${localStorage.getItem('jl-sync-branch') || 'gh-pages'}" />

          <label for="jl-sync-path">Content subdirectory</label>
          <input id="jl-sync-path" type="text"
                 placeholder="e.g. files (empty = sync all)"
                 value="${localStorage.getItem('jl-sync-path') || 'files'}" />

          <p style="font-size: 0.85em; color: var(--jp-ui-font-color2); margin-top: 8px;">
            This will pull files from the repository and update your local
            JupyterLite file system.
          </p>
        `;
                const syncResult = await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Pull from Repository',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: syncBody }),
                    buttons: [
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.cancelButton(),
                        _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Pull' }),
                    ],
                });
                if (!syncResult.button.accept)
                    return;
                const repoUrl = syncBody.querySelector('#jl-sync-repo').value.trim();
                const branch = syncBody.querySelector('#jl-sync-branch').value.trim() || 'gh-pages';
                const contentPath = syncBody.querySelector('#jl-sync-path').value.trim();
                if (!repoUrl) {
                    void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                        title: 'Sync Error',
                        body: 'Repository URL is required.',
                        buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton()],
                    });
                    return;
                }
                // Persist settings
                localStorage.setItem('jl-deploy-repo', repoUrl);
                localStorage.setItem('jl-sync-branch', branch);
                localStorage.setItem('jl-sync-path', contentPath);
                const proxyUrl = (0,_proxy_http__WEBPACK_IMPORTED_MODULE_4__.getProxyUrl)();
                // Show progress
                const statusNode = document.createElement('pre');
                statusNode.classList.add('jl-deploy-status');
                statusNode.textContent = 'Starting sync…\n';
                const statusWidget = new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: statusNode });
                void (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Syncing…',
                    body: statusWidget,
                    buttons: [],
                });
                const log = (msg) => {
                    statusNode.textContent += msg + '\n';
                    statusNode.scrollTop = statusNode.scrollHeight;
                };
                try {
                    const result = await (0,_deploy__WEBPACK_IMPORTED_MODULE_3__.syncFromRepo)(app.serviceManager.contents, {
                        repoUrl,
                        branch,
                        token,
                        contentPath,
                        proxyUrl,
                        onProgress: log,
                    });
                    log(`\nComplete: ${result.updated}/${result.total} files updated.`);
                    if (result.updated > 0) {
                        log('Refresh the page to see updated files in the file browser.');
                    }
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log(`\nERROR: ${errMsg}`);
                }
                await new Promise(r => setTimeout(r, 300));
                _jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.flush();
                const finalNode = document.createElement('pre');
                finalNode.classList.add('jl-deploy-status');
                finalNode.textContent = (_a = statusNode.textContent) !== null && _a !== void 0 ? _a : '';
                await (0,_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.showDialog)({
                    title: 'Sync Result',
                    body: new _lumino_widgets__WEBPACK_IMPORTED_MODULE_2__.Widget({ node: finalNode }),
                    buttons: [_jupyterlab_apputils__WEBPACK_IMPORTED_MODULE_1__.Dialog.okButton({ label: 'Close' })],
                });
            },
        });
        // Login command (standalone OAuth flow)
        app.commands.addCommand(CMD_LOGIN, {
            label: 'Wiki3.ai Sync: Login with GitHub',
            caption: 'Authenticate with GitHub using the OAuth Device Flow',
            execute: async () => {
                const token = await ensureToken();
                if (token) {
                    console.log('jupyterlite-deploy: OAuth login successful');
                }
            },
        });
        // Add all commands to the command palette
        if (palette) {
            palette.addItem({ command: CMD_DEPLOY, category: 'Wiki3.ai Sync' });
            palette.addItem({ command: CMD_SYNC, category: 'Wiki3.ai Sync' });
            palette.addItem({ command: CMD_LOGIN, category: 'Wiki3.ai Sync' });
        }
        console.log('jupyterlite-deploy: commands registered', CMD_DEPLOY, CMD_SYNC, CMD_LOGIN);
    },
};
/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (plugin);


/***/ },

/***/ "./lib/memfs.js"
/*!**********************!*\
  !*** ./lib/memfs.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MemFS: () => (/* binding */ MemFS)
/* harmony export */ });
/**
 * Minimal in-memory filesystem implementing the interface required by
 * isomorphic-git (Node.js `fs.promises`-style API).
 *
 * No IndexedDB, no lightning-fs — everything lives in a Map for the duration
 * of the deploy operation and is discarded afterward.
 */
function normalize(p) {
    // Remove trailing slashes, collapse multiples, ensure leading /
    const parts = p.split('/').filter(Boolean);
    return '/' + parts.join('/');
}
function dirname(p) {
    const norm = normalize(p);
    const idx = norm.lastIndexOf('/');
    return idx <= 0 ? '/' : norm.slice(0, idx);
}
function makeStat(node, ino) {
    const isFile = node.type === 'file';
    return {
        type: node.type,
        mode: node.mode,
        size: node.content ? node.content.length : 0,
        ino,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.mtimeMs,
        uid: 1,
        gid: 1,
        dev: 1,
        isFile: () => isFile,
        isDirectory: () => !isFile,
        isSymbolicLink: () => false,
    };
}
/**
 * An in-memory filesystem compatible with isomorphic-git's `fs` parameter.
 *
 * Usage:
 * ```ts
 * const fs = new MemFS();
 * await git.init({ fs, dir: '/' });
 * ```
 */
class MemFS {
    constructor() {
        this._nodes = new Map();
        this._nextIno = 1;
        this._nodes.set('/', {
            type: 'dir',
            mode: 0o755,
            mtimeMs: Date.now(),
        });
        // Bind all fs methods as own properties so isomorphic-git can find them
        this.readFile = this._readFile.bind(this);
        this.writeFile = this._writeFile.bind(this);
        this.unlink = this._unlink.bind(this);
        this.readdir = this._readdir.bind(this);
        this.mkdir = this._mkdir.bind(this);
        this.rmdir = this._rmdir.bind(this);
        this.stat = this._stat.bind(this);
        this.lstat = this._stat.bind(this); // no symlinks
        this.readlink = this._readlink.bind(this);
        this.symlink = this._symlink.bind(this);
        this.chmod = this._chmod.bind(this);
    }
    /** Legacy getter kept for backwards compat with our own code. */
    get promises() {
        return {
            readFile: this.readFile,
            writeFile: this.writeFile,
            unlink: this.unlink,
            readdir: this.readdir,
            mkdir: this.mkdir,
            rmdir: this.rmdir,
            stat: this.stat,
            lstat: this.lstat,
            readlink: this.readlink,
            symlink: this.symlink,
            chmod: this.chmod,
        };
    }
    // ── helpers ──────────────────────────────────────────────────────────
    _ensureParentDirs(p) {
        const parts = normalize(p).split('/').filter(Boolean);
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
            cur += '/' + parts[i];
            if (!this._nodes.has(cur)) {
                this._nodes.set(cur, {
                    type: 'dir',
                    mode: 0o755,
                    mtimeMs: Date.now(),
                });
            }
        }
    }
    // ── fs.promises implementations ─────────────────────────────────────
    async _readFile(filepath, opts) {
        var _a;
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node || node.type !== 'file') {
            throw Object.assign(new Error(`ENOENT: no such file '${p}'`), {
                code: 'ENOENT',
            });
        }
        const data = (_a = node.content) !== null && _a !== void 0 ? _a : new Uint8Array(0);
        if ((opts === null || opts === void 0 ? void 0 : opts.encoding) === 'utf8') {
            return new TextDecoder().decode(data);
        }
        return data;
    }
    async _writeFile(filepath, data, opts) {
        var _a, _b;
        const p = normalize(filepath);
        this._ensureParentDirs(p);
        const content = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const existing = this._nodes.get(p);
        this._nodes.set(p, {
            type: 'file',
            mode: (_b = (_a = opts === null || opts === void 0 ? void 0 : opts.mode) !== null && _a !== void 0 ? _a : existing === null || existing === void 0 ? void 0 : existing.mode) !== null && _b !== void 0 ? _b : 0o644,
            content,
            mtimeMs: Date.now(),
        });
    }
    async _unlink(filepath) {
        const p = normalize(filepath);
        if (!this._nodes.has(p)) {
            throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
        }
        this._nodes.delete(p);
    }
    async _readdir(filepath) {
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node || node.type !== 'dir') {
            throw Object.assign(new Error(`ENOTDIR: '${p}'`), { code: 'ENOTDIR' });
        }
        const prefix = p === '/' ? '/' : p + '/';
        const entries = new Set();
        for (const key of this._nodes.keys()) {
            if (key === p)
                continue;
            if (key.startsWith(prefix)) {
                // direct child only
                const rest = key.slice(prefix.length);
                const name = rest.split('/')[0];
                if (name)
                    entries.add(name);
            }
        }
        return Array.from(entries);
    }
    async _mkdir(filepath, opts) {
        const p = normalize(filepath);
        if (opts === null || opts === void 0 ? void 0 : opts.recursive) {
            this._ensureParentDirs(p + '/placeholder');
            if (!this._nodes.has(p)) {
                this._nodes.set(p, {
                    type: 'dir',
                    mode: 0o755,
                    mtimeMs: Date.now(),
                });
            }
            return;
        }
        const parent = dirname(p);
        if (!this._nodes.has(parent)) {
            throw Object.assign(new Error(`ENOENT: '${parent}'`), {
                code: 'ENOENT',
            });
        }
        if (this._nodes.has(p)) {
            throw Object.assign(new Error(`EEXIST: '${p}'`), { code: 'EEXIST' });
        }
        this._nodes.set(p, { type: 'dir', mode: 0o755, mtimeMs: Date.now() });
    }
    async _rmdir(filepath) {
        const p = normalize(filepath);
        this._nodes.delete(p);
    }
    async _stat(filepath) {
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node) {
            throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
        }
        return makeStat(node, this._nextIno++);
    }
    async _readlink(_filepath) {
        throw Object.assign(new Error('ENOSYS: readlink'), { code: 'ENOSYS' });
    }
    async _symlink(_target, _filepath) {
        throw Object.assign(new Error('ENOSYS: symlink'), { code: 'ENOSYS' });
    }
    async _chmod(filepath, mode) {
        const p = normalize(filepath);
        const node = this._nodes.get(p);
        if (!node) {
            throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
        }
        node.mode = mode;
    }
}


/***/ },

/***/ "./lib/oauth.js"
/*!**********************!*\
  !*** ./lib/oauth.js ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   cacheToken: () => (/* binding */ cacheToken),
/* harmony export */   getCachedToken: () => (/* binding */ getCachedToken),
/* harmony export */   startOAuthPopup: () => (/* binding */ startOAuthPopup)
/* harmony export */ });
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
function startOAuthPopup(proxyUrl) {
    return new Promise((resolve, reject) => {
        // Generate a nonce to tie request → response
        const nonce = generateNonce();
        const origin = window.location.origin;
        const authUrl = `${proxyUrl}/oauth/authorize` +
            `?nonce=${encodeURIComponent(nonce)}` +
            `&return_origin=${encodeURIComponent(origin)}`;
        // Open popup immediately (preserves user-gesture for popup blockers)
        const popup = window.open(authUrl, 'wiki3-oauth', 'width=600,height=700,popup=yes');
        if (!popup) {
            reject(new Error('Popup blocked by the browser. Please allow popups for this site and try again.'));
            return;
        }
        let settled = false;
        // Listen for the token via postMessage from the callback page
        const onMessage = (event) => {
            var _a, _b;
            // Verify the message comes from the proxy worker
            const proxyOrigin = new URL(proxyUrl).origin;
            if (event.origin !== proxyOrigin)
                return;
            if (((_a = event.data) === null || _a === void 0 ? void 0 : _a.type) !== 'wiki3-oauth')
                return;
            if (((_b = event.data) === null || _b === void 0 ? void 0 : _b.nonce) !== nonce)
                return;
            cleanup();
            if (event.data.token) {
                settled = true;
                resolve(event.data.token);
            }
            else {
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
function getCachedToken() {
    if (typeof sessionStorage !== 'undefined') {
        return sessionStorage.getItem('jl-deploy-token') || null;
    }
    return null;
}
/**
 * Cache a token in sessionStorage (cleared when tab closes).
 */
function cacheToken(token) {
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('jl-deploy-token', token);
    }
}
/** Generate a random nonce string for CSRF protection. */
function generateNonce() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for older browsers
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}


/***/ },

/***/ "./lib/proxy-http.js"
/*!***************************!*\
  !*** ./lib/proxy-http.js ***!
  \***************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   detectRepoUrl: () => (/* binding */ detectRepoUrl),
/* harmony export */   getDefaultRepoUrl: () => (/* binding */ getDefaultRepoUrl),
/* harmony export */   getProxyUrl: () => (/* binding */ getProxyUrl),
/* harmony export */   makeProxyHttp: () => (/* binding */ makeProxyHttp)
/* harmony export */ });
/* harmony import */ var isomorphic_git_http_web__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! isomorphic-git/http/web */ "./node_modules/isomorphic-git/http/web/index.js");
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

/**
 * Create an isomorphic-git compatible HTTP client that routes
 * github.com requests through the CORS proxy.
 *
 * @param proxyBaseUrl - The base URL of the proxy worker,
 *                       e.g. "https://wiki3-ai-sync-proxy.you.workers.dev"
 *                       If empty/null, requests go directly (for testing).
 */
function makeProxyHttp(proxyBaseUrl) {
    return {
        async request(config) {
            let { url } = config;
            // Rewrite github.com URLs to go through the proxy
            if (proxyBaseUrl && url.startsWith('https://github.com/')) {
                const path = url.slice('https://github.com/'.length);
                url = `${proxyBaseUrl.replace(/\/+$/, '')}/proxy/${path}`;
            }
            return isomorphic_git_http_web__WEBPACK_IMPORTED_MODULE_0__["default"].request({ ...config, url });
        },
    };
}
/** Default CORS proxy URL for the Wiki3.ai Sync worker. */
const DEFAULT_PROXY_URL = 'https://wiki3-ai-sync-proxy.jim-2ad.workers.dev';
/**
 * The proxy URL to use. Checks localStorage override, falls back to the
 * built-in default so users never need to configure it.
 */
function getProxyUrl() {
    if (typeof localStorage !== 'undefined') {
        const custom = localStorage.getItem('jl-deploy-proxy');
        if (custom)
            return custom;
    }
    return DEFAULT_PROXY_URL;
}
/**
 * Auto-detect the GitHub repo URL from the current site's location.
 * Works for GitHub Pages sites: https://<org>.github.io/<repo>/
 * Returns empty string if detection fails.
 */
function detectRepoUrl() {
    if (typeof window === 'undefined')
        return '';
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
    }
    catch (_a) {
        // ignore
    }
    return '';
}
/**
 * Get the default repo URL: check localStorage, then auto-detect from site URL.
 */
function getDefaultRepoUrl() {
    if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('jl-deploy-repo');
        if (saved)
            return saved;
    }
    return detectRepoUrl();
}


/***/ },

/***/ "./node_modules/isomorphic-git/http/web/index.js"
/*!*******************************************************!*\
  !*** ./node_modules/isomorphic-git/http/web/index.js ***!
  \*******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   "default": () => (__WEBPACK_DEFAULT_EXPORT__),
/* harmony export */   request: () => (/* binding */ request)
/* harmony export */ });
/**
 * @typedef {Object} GitProgressEvent
 * @property {string} phase
 * @property {number} loaded
 * @property {number} total
 */

/**
 * @callback ProgressCallback
 * @param {GitProgressEvent} progress
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {Object} GitHttpRequest
 * @property {string} url - The URL to request
 * @property {string} [method='GET'] - The HTTP method to use
 * @property {Object<string, string>} [headers={}] - Headers to include in the HTTP request
 * @property {Object} [agent] - An HTTP or HTTPS agent that manages connections for the HTTP client (Node.js only)
 * @property {AsyncIterableIterator<Uint8Array>} [body] - An async iterator of Uint8Arrays that make up the body of POST requests
 * @property {ProgressCallback} [onProgress] - Reserved for future use (emitting `GitProgressEvent`s)
 * @property {object} [signal] - Reserved for future use (canceling a request)
 */

/**
 * @typedef {Object} GitHttpResponse
 * @property {string} url - The final URL that was fetched after any redirects
 * @property {string} [method] - The HTTP method that was used
 * @property {Object<string, string>} [headers] - HTTP response headers
 * @property {AsyncIterableIterator<Uint8Array>} [body] - An async iterator of Uint8Arrays that make up the body of the response
 * @property {number} statusCode - The HTTP status code
 * @property {string} statusMessage - The HTTP status message
 */

/**
 * @callback HttpFetch
 * @param {GitHttpRequest} request
 * @returns {Promise<GitHttpResponse>}
 */

/**
 * @typedef {Object} HttpClient
 * @property {HttpFetch} request
 */

// Convert a value to an Async Iterator
// This will be easier with async generator functions.
function fromValue(value) {
  let queue = [value];
  return {
    next() {
      return Promise.resolve({ done: queue.length === 0, value: queue.pop() })
    },
    return() {
      queue = [];
      return {}
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

function getIterator(iterable) {
  if (iterable[Symbol.asyncIterator]) {
    return iterable[Symbol.asyncIterator]()
  }
  if (iterable[Symbol.iterator]) {
    return iterable[Symbol.iterator]()
  }
  if (iterable.next) {
    return iterable
  }
  return fromValue(iterable)
}

// Currently 'for await' upsets my linters.
async function forAwait(iterable, cb) {
  const iter = getIterator(iterable);
  while (true) {
    const { value, done } = await iter.next();
    if (value) await cb(value);
    if (done) break
  }
  if (iter.return) iter.return();
}

async function collect(iterable) {
  let size = 0;
  const buffers = [];
  // This will be easier once `for await ... of` loops are available.
  await forAwait(iterable, value => {
    buffers.push(value);
    size += value.byteLength;
  });
  const result = new Uint8Array(size);
  let nextIndex = 0;
  for (const buffer of buffers) {
    result.set(buffer, nextIndex);
    nextIndex += buffer.byteLength;
  }
  return result
}

// Convert a web ReadableStream (not Node stream!) to an Async Iterator
// adapted from https://jakearchibald.com/2017/async-iterators-and-generators/
function fromStream(stream) {
  // Use native async iteration if it's available.
  if (stream[Symbol.asyncIterator]) return stream
  const reader = stream.getReader();
  return {
    next() {
      return reader.read()
    },
    return() {
      reader.releaseLock();
      return {}
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/* eslint-env browser */

/**
 * HttpClient
 *
 * @param {GitHttpRequest} request
 * @returns {Promise<GitHttpResponse>}
 */
async function request({
  onProgress,
  url,
  method = 'GET',
  headers = {},
  body,
}) {
  // streaming uploads aren't possible yet in the browser
  if (body) {
    body = await collect(body);
  }
  const res = await fetch(url, { method, headers, body });
  const iter =
    res.body && res.body.getReader
      ? fromStream(res.body)
      : [new Uint8Array(await res.arrayBuffer())];
  // convert Header object to ordinary JSON
  headers = {};
  for (const [key, value] of res.headers.entries()) {
    headers[key] = value;
  }
  return {
    url: res.url,
    method: res.method,
    statusCode: res.status,
    statusMessage: res.statusText,
    body: iter,
    headers,
  }
}

var index = { request };

/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (index);



/***/ }

}]);
//# sourceMappingURL=lib_index_js.d97c649e14b34e992c30.js.map