/**
 * jupyterlite-deploy — JupyterLab/JupyterLite extension
 *
 * Adds a "Deploy to GitHub Pages" command that uses isomorphic-git
 * to push files from the Contents API to a gh-pages branch.
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
import { getProxyUrl } from './proxy-http';
import { requestDeviceCode, pollForToken, cacheToken } from './oauth';

/** Command IDs */
const CMD_DEPLOY = 'deploy:gh-pages';
const CMD_SYNC = 'deploy:sync';
const CMD_LOGIN = 'deploy:login';

/**
 * Build the deploy configuration dialog body.
 */
function createDeployDialogBody(): HTMLElement {
  const body = document.createElement('div');
  body.classList.add('jl-deploy-dialog');
  body.innerHTML = `
    <label for="jl-deploy-proxy">CORS Proxy URL</label>
    <input id="jl-deploy-proxy" type="text"
           placeholder="https://your-worker.workers.dev"
           value="${localStorage.getItem('jl-deploy-proxy') ?? ''}" />

    <label for="jl-deploy-repo">Repository URL</label>
    <input id="jl-deploy-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${localStorage.getItem('jl-deploy-repo') ?? ''}" />

    <label for="jl-deploy-branch">Branch</label>
    <input id="jl-deploy-branch" type="text"
           value="${localStorage.getItem('jl-deploy-branch') || 'gh-pages'}" />

    <label for="jl-deploy-token">GitHub Token</label>
    <div style="display: flex; gap: 4px; align-items: center;">
      <input id="jl-deploy-token" type="password" style="flex: 1;"
             placeholder="ghp_… or use Login button"
             value="${sessionStorage.getItem('jl-deploy-token') ?? ''}" />
      <button id="jl-deploy-oauth-btn" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Login with GitHub</button>
      <button id="jl-deploy-clear-token" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Clear</button>
    </div>
    <div style="margin-top: 4px;">
      <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.85em; cursor: pointer;">
        <input id="jl-deploy-remember-token" type="checkbox"
               ${sessionStorage.getItem('jl-deploy-token') ? 'checked' : ''} />
        Remember token for this session
      </label>
    </div>

    <label for="jl-deploy-author">Author</label>
    <input id="jl-deploy-author" type="text"
           placeholder="Deploy Bot <deploy@example.com>"
           value="${localStorage.getItem('jl-deploy-author') || 'Deploy Bot <deploy@example.com>'}" />

    <label for="jl-deploy-message">Commit message</label>
    <input id="jl-deploy-message" type="text"
           value="Deploy JupyterLite site" />
  `;

  // Wire up buttons
  setTimeout(() => {
    const btn = body.querySelector('#jl-deploy-oauth-btn') as HTMLButtonElement;
    const clearBtn = body.querySelector('#jl-deploy-clear-token') as HTMLButtonElement;
    const tokenInput = body.querySelector('#jl-deploy-token') as HTMLInputElement;
    const proxyInput = body.querySelector('#jl-deploy-proxy') as HTMLInputElement;
    const rememberCb = body.querySelector('#jl-deploy-remember-token') as HTMLInputElement;
    if (btn) {
      btn.addEventListener('click', () => {
        void doOAuthLogin(proxyInput.value.trim(), tokenInput);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        tokenInput.value = '';
        rememberCb.checked = false;
        sessionStorage.removeItem('jl-deploy-token');
      });
    }
  }, 0);

  return body;
}

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
 * Perform GitHub OAuth Device Flow login.
 * Shows a dialog with the user code and verification URL,
 * polls for the token, and fills the token input.
 */
async function doOAuthLogin(
  proxyUrl: string,
  tokenInput: HTMLInputElement,
): Promise<void> {
  if (!proxyUrl) {
    await showDialog({
      title: 'OAuth Login',
      body: 'Please enter a CORS Proxy URL first.',
      buttons: [Dialog.okButton()],
    });
    return;
  }

  try {
    const oauthConfig = { proxyUrl };
    const { device_code, user_code, verification_uri, expires_in, interval } =
      await requestDeviceCode(oauthConfig);

    const msgNode = document.createElement('div');
    msgNode.innerHTML = `
      <p>Go to <a href="${verification_uri}" target="_blank" rel="noopener">
      ${verification_uri}</a> and enter this code:</p>
      <pre style="font-size: 1.5em; text-align: center; letter-spacing: 0.15em;
                  background: var(--jp-layout-color2); padding: 12px; border-radius: 4px;
                  user-select: all;">${user_code}</pre>
      <p id="jl-oauth-status" style="font-size: 0.85em; color: var(--jp-ui-font-color2);">
        Waiting for authorization…</p>
    `;

    const controller = new AbortController();

    // Show the dialog (non-blocking — user can cancel)
    const dialogPromise = showDialog({
      title: 'GitHub Device Login',
      body: new Widget({ node: msgNode }),
      buttons: [
        Dialog.cancelButton({ label: 'Cancel' }),
      ],
    });

    // When dialog is dismissed, abort polling
    dialogPromise.then(() => controller.abort()).catch(() => controller.abort());

    const statusEl = msgNode.querySelector('#jl-oauth-status');

    const result = await pollForToken(
      oauthConfig,
      device_code,
      interval,
      expires_in,
      (msg: string) => {
        if (statusEl) {
          statusEl.textContent = msg;
        }
      },
      controller.signal,
    );

    if (result) {
      cacheToken(result.access_token);
      tokenInput.value = result.access_token;
      if (statusEl) {
        statusEl.textContent = 'Logged in successfully!';
      }
      // Dismiss the dialog after a short delay
      await new Promise(r => setTimeout(r, 800));
      Dialog.flush();
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      await showDialog({
        title: 'OAuth Error',
        body: String(err.message || err),
        buttons: [Dialog.okButton()],
      });
    }
  }
}

/**
 * Extension activation.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlite-deploy:plugin',
  description: 'Deploy JupyterLite sites to GitHub Pages using isomorphic-git',
  autoStart: true,
  optional: [ICommandPalette],
  activate: (app: JupyterFrontEnd, palette: ICommandPalette | null) => {
    console.log('jupyterlite-deploy: activated');

    app.commands.addCommand(CMD_DEPLOY, {
      label: 'Wiki3.ai Sync: Deploy to GitHub Pages',
      caption: 'Push site contents to a gh-pages branch via isomorphic-git',
      execute: async () => {
        // ── 1. Show config dialog ────────────────────────────────────
        const body = createDeployDialogBody();
        const dialogResult = await showDialog({
          title: 'Deploy to GitHub Pages',
          body: new Widget({ node: body }),
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Deploy' }),
          ],
        });

        if (!dialogResult.button.accept) {
          return;
        }

        const repoUrl = (
          body.querySelector('#jl-deploy-repo') as HTMLInputElement
        ).value.trim();
        const branch = (
          body.querySelector('#jl-deploy-branch') as HTMLInputElement
        ).value.trim();
        const token = (
          body.querySelector('#jl-deploy-token') as HTMLInputElement
        ).value.trim();
        const authorRaw = (
          body.querySelector('#jl-deploy-author') as HTMLInputElement
        ).value.trim();
        const message = (
          body.querySelector('#jl-deploy-message') as HTMLInputElement
        ).value.trim();
        const proxyUrl = (
          body.querySelector('#jl-deploy-proxy') as HTMLInputElement
        ).value.trim();

        if (!repoUrl || !token) {
          void showDialog({
            title: 'Deploy Error',
            body: 'Repository URL and GitHub Token are required.',
            buttons: [Dialog.okButton()],
          });
          return;
        }

        // Persist non-secret settings for convenience
        localStorage.setItem('jl-deploy-repo', repoUrl);
        localStorage.setItem('jl-deploy-branch', branch);
        localStorage.setItem('jl-deploy-author', authorRaw);
        if (proxyUrl) localStorage.setItem('jl-deploy-proxy', proxyUrl);
        // Only remember token if checkbox is checked
        const rememberToken = (body.querySelector('#jl-deploy-remember-token') as HTMLInputElement)?.checked;
        if (rememberToken) {
          sessionStorage.setItem('jl-deploy-token', token);
        } else {
          sessionStorage.removeItem('jl-deploy-token');
        }

        const { name: authorName, email: authorEmail } =
          parseAuthor(authorRaw);

        // ── 2. Collect files ──────────────────────────────────────────
        const statusNode = document.createElement('pre');
        statusNode.classList.add('jl-deploy-status');
        statusNode.textContent = 'Collecting files…\n';
        const statusWidget = new Widget({ node: statusNode });

        void showDialog({
          title: 'Deploying…',
          body: statusWidget,
          buttons: [], // no user buttons while deploying
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

          // ── 3. Deploy ────────────────────────────────────────────────
          await deployToGitHub(files, {
            repoUrl,
            branch: branch || 'gh-pages',
            token,
            message: message || 'Deploy JupyterLite site',
            authorName,
            authorEmail,
            proxyUrl: proxyUrl || getProxyUrl(),
            onProgress: log,
          });

          log('\nDone!');
        } catch (err: unknown) {
          const errMsg =
            err instanceof Error ? err.message : String(err);
          log(`\nERROR: ${errMsg}`);
        }

        // Replace the modeless progress dialog with a closeable one
        // (the Dialog promise resolves when dismissed by code below)
        // We wait a beat so the user can read the final status.
        await new Promise(r => setTimeout(r, 300));
        // Close the progress dialog by resolving it
        Dialog.flush();

        // Show final status
        const finalNode = document.createElement('pre');
        finalNode.classList.add('jl-deploy-status');
        finalNode.textContent = statusNode.textContent ?? '';
        await showDialog({
          title: 'Deploy Result',
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
        const syncBody = createSyncDialogBody();
        const syncResult = await showDialog({
          title: 'Sync Files from Repository',
          body: new Widget({ node: syncBody }),
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Sync' }),
          ],
        });

        if (!syncResult.button.accept) {
          return;
        }

        const repoUrl = (
          syncBody.querySelector('#jl-sync-repo') as HTMLInputElement
        ).value.trim();
        const branch = (
          syncBody.querySelector('#jl-sync-branch') as HTMLInputElement
        ).value.trim();
        const token = (
          syncBody.querySelector('#jl-sync-token') as HTMLInputElement
        ).value.trim();
        const contentPath = (
          syncBody.querySelector('#jl-sync-path') as HTMLInputElement
        ).value.trim();
        const proxyUrl = (
          syncBody.querySelector('#jl-sync-proxy') as HTMLInputElement
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
        if (proxyUrl) localStorage.setItem('jl-deploy-proxy', proxyUrl);
        const rememberSyncToken = (syncBody.querySelector('#jl-sync-remember-token') as HTMLInputElement)?.checked;
        if (token && rememberSyncToken) {
          sessionStorage.setItem('jl-deploy-token', token);
        } else if (!rememberSyncToken) {
          sessionStorage.removeItem('jl-deploy-token');
        }

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
              branch: branch || 'gh-pages',
              token,
              contentPath,
              proxyUrl: proxyUrl || getProxyUrl(),
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
        const proxyUrl = localStorage.getItem('jl-deploy-proxy') || getProxyUrl() || '';
        if (!proxyUrl) {
          // Ask for proxy URL first if none is configured
          const node = document.createElement('div');
          node.innerHTML = `
            <label for="jl-login-proxy">CORS Proxy URL</label>
            <input id="jl-login-proxy" type="text"
                   placeholder="https://your-worker.workers.dev" />
          `;
          const result = await showDialog({
            title: 'GitHub OAuth Login',
            body: new Widget({ node }),
            buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Continue' })],
          });
          if (!result.button.accept) {
            return;
          }
          const proxy = (node.querySelector('#jl-login-proxy') as HTMLInputElement).value.trim();
          if (!proxy) {
            return;
          }
          localStorage.setItem('jl-deploy-proxy', proxy);
          // Now launch OAuth with the proxy
          const dummyInput = document.createElement('input');
          dummyInput.type = 'hidden';
          await doOAuthLogin(proxy, dummyInput);
          if (dummyInput.value) {
            sessionStorage.setItem('jl-deploy-token', dummyInput.value);
            console.log('jupyterlite-deploy: OAuth login successful');
          }
          return;
        }
        // Proxy is already configured — go straight to OAuth
        const dummyInput = document.createElement('input');
        dummyInput.type = 'hidden';
        await doOAuthLogin(proxyUrl, dummyInput);
        if (dummyInput.value) {
          sessionStorage.setItem('jl-deploy-token', dummyInput.value);
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

/**
 * Build the sync configuration dialog body.
 */
function createSyncDialogBody(): HTMLElement {
  const body = document.createElement('div');
  body.classList.add('jl-deploy-dialog');
  body.innerHTML = `
    <label for="jl-sync-proxy">CORS Proxy URL</label>
    <input id="jl-sync-proxy" type="text"
           placeholder="https://your-worker.workers.dev"
           value="${localStorage.getItem('jl-deploy-proxy') ?? ''}" />

    <label for="jl-sync-repo">Repository URL</label>
    <input id="jl-sync-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${localStorage.getItem('jl-deploy-repo') ?? ''}" />

    <label for="jl-sync-branch">Branch</label>
    <input id="jl-sync-branch" type="text"
           value="${localStorage.getItem('jl-sync-branch') || 'gh-pages'}" />

    <label for="jl-sync-token">GitHub Token (optional for public repos)</label>
    <div style="display: flex; gap: 4px; align-items: center;">
      <input id="jl-sync-token" type="password" style="flex: 1;"
             placeholder="ghp_… (leave empty for public repos)"
             value="${sessionStorage.getItem('jl-deploy-token') ?? ''}" />
      <button id="jl-sync-oauth-btn" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Login with GitHub</button>
      <button id="jl-sync-clear-token" type="button"
              style="white-space: nowrap; padding: 2px 8px;">Clear</button>
    </div>
    <div style="margin-top: 4px;">
      <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.85em; cursor: pointer;">
        <input id="jl-sync-remember-token" type="checkbox"
               ${sessionStorage.getItem('jl-deploy-token') ? 'checked' : ''} />
        Remember token for this session
      </label>
    </div>

    <label for="jl-sync-path">Content subdirectory (optional)</label>
    <input id="jl-sync-path" type="text"
           placeholder="e.g. files (empty = sync all)"
           value="${localStorage.getItem('jl-sync-path') || 'files'}" />

    <p style="font-size: 0.85em; color: var(--jp-ui-font-color2); margin-top: 8px;">
      This will pull files from the repository and update your local
      JupyterLite file system, replacing any stale cached versions.
    </p>
  `;

  // Wire up buttons
  setTimeout(() => {
    const btn = body.querySelector('#jl-sync-oauth-btn') as HTMLButtonElement;
    const clearBtn = body.querySelector('#jl-sync-clear-token') as HTMLButtonElement;
    const tokenInput = body.querySelector('#jl-sync-token') as HTMLInputElement;
    const proxyInput = body.querySelector('#jl-sync-proxy') as HTMLInputElement;
    const rememberCb = body.querySelector('#jl-sync-remember-token') as HTMLInputElement;
    if (btn) {
      btn.addEventListener('click', () => {
        void doOAuthLogin(proxyInput.value.trim(), tokenInput);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        tokenInput.value = '';
        rememberCb.checked = false;
        sessionStorage.removeItem('jl-deploy-token');
      });
    }
  }, 0);

  return body;
}
