/**
 * jupyterlite-deploy — JupyterLab/JupyterLite extension
 *
 * Adds a "Deploy to GitHub Pages" command that uses isomorphic-git
 * to push files from the Contents API to a gh-pages branch.
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';
import { Dialog, ICommandPalette, showDialog } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';
import { deployToGitHub, collectContentsFiles, syncFromRepo, IFileEntry } from './deploy';

/** Command IDs */
const CMD_DEPLOY = 'deploy:gh-pages';
const CMD_SYNC = 'deploy:sync';

/**
 * Build the deploy configuration dialog body.
 */
function createDeployDialogBody(): HTMLElement {
  const body = document.createElement('div');
  body.classList.add('jl-deploy-dialog');
  body.innerHTML = `
    <label for="jl-deploy-repo">Repository URL</label>
    <input id="jl-deploy-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${localStorage.getItem('jl-deploy-repo') ?? ''}" />

    <label for="jl-deploy-branch">Branch</label>
    <input id="jl-deploy-branch" type="text"
           value="${localStorage.getItem('jl-deploy-branch') || 'gh-pages'}" />

    <label for="jl-deploy-token">GitHub Token</label>
    <input id="jl-deploy-token" type="password"
           placeholder="ghp_…"
           value="${sessionStorage.getItem('jl-deploy-token') ?? ''}" />

    <label for="jl-deploy-author">Author</label>
    <input id="jl-deploy-author" type="text"
           placeholder="Deploy Bot <deploy@example.com>"
           value="${localStorage.getItem('jl-deploy-author') || 'Deploy Bot <deploy@example.com>'}" />

    <label for="jl-deploy-message">Commit message</label>
    <input id="jl-deploy-message" type="text"
           value="Deploy JupyterLite site" />
  `;
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
      label: 'Deploy to GitHub Pages',
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
        // Token goes to sessionStorage (cleared when tab closes)
        sessionStorage.setItem('jl-deploy-token', token);

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
      label: 'Sync Files from Repository',
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
        if (token) {
          sessionStorage.setItem('jl-deploy-token', token);
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

    // Add both commands to the command palette
    if (palette) {
      palette.addItem({ command: CMD_DEPLOY, category: 'Deploy' });
      palette.addItem({ command: CMD_SYNC, category: 'Deploy' });
    }

    console.log('jupyterlite-deploy: commands registered', CMD_DEPLOY, CMD_SYNC);
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
    <label for="jl-sync-repo">Repository URL</label>
    <input id="jl-sync-repo" type="text"
           placeholder="https://github.com/user/repo.git"
           value="${localStorage.getItem('jl-deploy-repo') ?? ''}" />

    <label for="jl-sync-branch">Branch</label>
    <input id="jl-sync-branch" type="text"
           value="${localStorage.getItem('jl-sync-branch') || 'gh-pages'}" />

    <label for="jl-sync-token">GitHub Token (optional for public repos)</label>
    <input id="jl-sync-token" type="password"
           placeholder="ghp_… (leave empty for public repos)"
           value="${sessionStorage.getItem('jl-deploy-token') ?? ''}" />

    <label for="jl-sync-path">Content subdirectory (optional)</label>
    <input id="jl-sync-path" type="text"
           placeholder="e.g. files (empty = sync all)"
           value="${localStorage.getItem('jl-sync-path') || 'files'}" />

    <p style="font-size: 0.85em; color: var(--jp-ui-font-color2); margin-top: 8px;">
      This will pull files from the repository and update your local
      JupyterLite file system, replacing any stale cached versions.
    </p>
  `;
  return body;
}
