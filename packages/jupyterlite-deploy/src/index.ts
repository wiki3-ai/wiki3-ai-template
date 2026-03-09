/**
 * jupyterlite-deploy — JupyterLab/JupyterLite extension
 *
 * Adds a "Push to GitHub Pages" command that uses isomorphic-git
 * to push content files to a git branch.
 */

// Polyfill Buffer for isomorphic-git (webpack 5 doesn't auto-polyfill Node globals)
import { Buffer } from 'buffer';
if (typeof (globalThis as any).Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';
import { Dialog, ICommandPalette, showDialog } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';
import { deployToGitHub, collectContentsFiles, syncFromRepo, IFileEntry } from './deploy';
import { getProxyUrl, getDefaultRepoUrl } from './proxy-http';
import { startOAuthPopup, cacheToken, getCachedToken } from './oauth';

/** Command IDs */
const CMD_DEPLOY = 'deploy:gh-pages';
const CMD_SYNC = 'deploy:sync';
const CMD_LOGIN = 'deploy:login';

/**
 * Parse "Name <email>" into { name, email }.
 */
function parseAuthor(raw: string): { name: string; email: string } {
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
async function doOAuthLogin(proxyUrl: string): Promise<string> {
  if (!proxyUrl) {
    await showDialog({
      title: 'OAuth Login',
      body: 'CORS Proxy URL is not configured.',
      buttons: [Dialog.okButton()],
    });
    return '';
  }

  try {
    const token = await startOAuthPopup(proxyUrl);
    if (token) {
      cacheToken(token);
      return token;
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    // Don't show error if the user just closed the popup
    if (!msg.includes('cancelled') && !msg.includes('closed')) {
      await showDialog({
        title: 'OAuth Error',
        body: msg,
        buttons: [Dialog.okButton()],
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
async function ensureToken(): Promise<string> {
  // Check session storage first
  const cached = sessionStorage.getItem('jl-deploy-token');
  if (cached) return cached;

  // Check the oauth module's in-memory cache
  const oauthCached = getCachedToken();
  if (oauthCached) return oauthCached;

  // No token — trigger OAuth login automatically
  const proxyUrl = getProxyUrl();
  const token = await doOAuthLogin(proxyUrl);
  if (token) {
    sessionStorage.setItem('jl-deploy-token', token);
  }
  return token;
}

/**
 * Extension activation.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlite-deploy:plugin',
  description: 'Push content files to GitHub Pages using isomorphic-git',
  autoStart: true,
  optional: [ICommandPalette],
  activate: (app: JupyterFrontEnd, palette: ICommandPalette | null) => {
    console.log('jupyterlite-deploy: activated');

    app.commands.addCommand(CMD_DEPLOY, {
      label: 'Wiki3.ai Sync: Push to GitHub',
      caption: 'Push content files to the main branch',
      execute: async () => {
        // ── 1. Ensure we have a token (auto-login if needed) ─────
        const token = await ensureToken();
        if (!token) return; // user cancelled

        // ── 2. Show lightweight config dialog ────────────────────
        const repoDefault = getDefaultRepoUrl();
        const body = document.createElement('div');
        body.classList.add('jl-deploy-dialog');
        body.innerHTML = `
          <label for="jl-deploy-repo">Repository</label>
          <input id="jl-deploy-repo" type="text"
                 placeholder="https://github.com/user/repo"
                 value="${repoDefault}" />

          <label for="jl-deploy-branch">Branch</label>
          <input id="jl-deploy-branch" type="text"
                 value="${localStorage.getItem('jl-deploy-branch') || 'main'}" />

          <label for="jl-deploy-message">Commit message</label>
          <input id="jl-deploy-message" type="text"
                 value="Update content files" />
        `;

        const dialogResult = await showDialog({
          title: 'Push to GitHub',
          body: new Widget({ node: body }),
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Push' }),
          ],
        });

        if (!dialogResult.button.accept) return;

        const repoUrl = (
          body.querySelector('#jl-deploy-repo') as HTMLInputElement
        ).value.trim();
        const branch = (
          body.querySelector('#jl-deploy-branch') as HTMLInputElement
        ).value.trim() || 'main';
        const message = (
          body.querySelector('#jl-deploy-message') as HTMLInputElement
        ).value.trim() || 'Update content files';

        if (!repoUrl) {
          void showDialog({
            title: 'Push Error',
            body: 'Repository URL is required.',
            buttons: [Dialog.okButton()],
          });
          return;
        }

        // Persist settings for next time
        localStorage.setItem('jl-deploy-repo', repoUrl);
        localStorage.setItem('jl-deploy-branch', branch);

        const proxyUrl = getProxyUrl();
        const authorRaw = localStorage.getItem('jl-deploy-author') || 'Wiki3 Bot <deploy@wiki3.ai>';
        const { name: authorName, email: authorEmail } = parseAuthor(authorRaw);

        // ── 3. Collect files + push ──────────────────────────────
        const statusNode = document.createElement('pre');
        statusNode.classList.add('jl-deploy-status');
        statusNode.textContent = 'Collecting files…\n';
        const statusWidget = new Widget({ node: statusNode });

        void showDialog({
          title: 'Pushing…',
          body: statusWidget,
          buttons: [], // no user buttons while pushing
        });

        const log = (msg: string) => {
          statusNode.textContent += msg + '\n';
          statusNode.scrollTop = statusNode.scrollHeight;
        };

        try {
          log('Reading files from Contents API…');
          const files: IFileEntry[] = await collectContentsFiles(
            app.serviceManager.contents
          );
          log(`Collected ${files.length} file(s).`);

          await deployToGitHub(files, {
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
        } catch (err: unknown) {
          const errMsg =
            err instanceof Error ? err.message : String(err);
          log(`\nERROR: ${errMsg}`);
        }

        await new Promise(r => setTimeout(r, 300));
        Dialog.flush();

        // Show final status
        const finalNode = document.createElement('pre');
        finalNode.classList.add('jl-deploy-status');
        finalNode.textContent = statusNode.textContent ?? '';
        await showDialog({
          title: 'Push Result',
          body: new Widget({ node: finalNode }),
          buttons: [Dialog.okButton({ label: 'Close' })],
        });
      },
    });

    // ── Sync from Repository command ───────────────────────────────
    app.commands.addCommand(CMD_SYNC, {
      label: 'Wiki3.ai Sync: Pull from Repository',
      caption: 'Pull latest content files from a git branch into JupyterLite',
      execute: async () => {
        // ── 1. Ensure we have a token (auto-login if needed) ─────
        // Token is optional for public repos, but try to get one
        const token = await ensureToken();
        // Don't block on missing token — public repos work without it

        // ── 2. Show lightweight config dialog ────────────────────
        const repoDefault = getDefaultRepoUrl();
        const syncBody = document.createElement('div');
        syncBody.classList.add('jl-deploy-dialog');
        syncBody.innerHTML = `
          <label for="jl-sync-repo">Repository</label>
          <input id="jl-sync-repo" type="text"
                 placeholder="https://github.com/user/repo"
                 value="${repoDefault}" />

          <label for="jl-sync-branch">Branch</label>
          <input id="jl-sync-branch" type="text"
                 value="${localStorage.getItem('jl-sync-branch') || 'main'}" />

          <label for="jl-sync-path">Content subdirectory</label>
          <input id="jl-sync-path" type="text"
                 placeholder="e.g. files (empty = sync all)"
                 value="${localStorage.getItem('jl-sync-path') || 'files'}" />

          <p style="font-size: 0.85em; color: var(--jp-ui-font-color2); margin-top: 8px;">
            This will pull files from the repository and update your local
            JupyterLite file system.
          </p>
        `;

        const syncResult = await showDialog({
          title: 'Pull from Repository',
          body: new Widget({ node: syncBody }),
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Pull' }),
          ],
        });

        if (!syncResult.button.accept) return;

        const repoUrl = (
          syncBody.querySelector('#jl-sync-repo') as HTMLInputElement
        ).value.trim();
        const branch = (
          syncBody.querySelector('#jl-sync-branch') as HTMLInputElement
        ).value.trim() || 'main';
        const contentPath = (
          syncBody.querySelector('#jl-sync-path') as HTMLInputElement
        ).value.trim();

        if (!repoUrl) {
          void showDialog({
            title: 'Sync Error',
            body: 'Repository URL is required.',
            buttons: [Dialog.okButton()],
          });
          return;
        }

        // Persist settings
        localStorage.setItem('jl-deploy-repo', repoUrl);
        localStorage.setItem('jl-sync-branch', branch);
        localStorage.setItem('jl-sync-path', contentPath);

        const proxyUrl = getProxyUrl();

        // Show progress
        const statusNode = document.createElement('pre');
        statusNode.classList.add('jl-deploy-status');
        statusNode.textContent = 'Starting sync…\n';
        const statusWidget = new Widget({ node: statusNode });

        void showDialog({
          title: 'Syncing…',
          body: statusWidget,
          buttons: [],
        });

        const log = (msg: string) => {
          statusNode.textContent += msg + '\n';
          statusNode.scrollTop = statusNode.scrollHeight;
        };

        try {
          const result = await syncFromRepo(
            app.serviceManager.contents,
            {
              repoUrl,
              branch,
              token,
              contentPath,
              proxyUrl,
              onProgress: log,
            }
          );
          log(`\nComplete: ${result.updated}/${result.total} files updated.`);
          if (result.updated > 0) {
            log('Refresh the page to see updated files in the file browser.');
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`\nERROR: ${errMsg}`);
        }

        await new Promise(r => setTimeout(r, 300));
        Dialog.flush();

        const finalNode = document.createElement('pre');
        finalNode.classList.add('jl-deploy-status');
        finalNode.textContent = statusNode.textContent ?? '';
        await showDialog({
          title: 'Sync Result',
          body: new Widget({ node: finalNode }),
          buttons: [Dialog.okButton({ label: 'Close' })],
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

export default plugin;
