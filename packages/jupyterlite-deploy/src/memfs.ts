/**
 * Minimal in-memory filesystem implementing the interface required by
 * isomorphic-git (Node.js `fs.promises`-style API).
 *
 * No IndexedDB, no lightning-fs — everything lives in a Map for the duration
 * of the deploy operation and is discarded afterward.
 */

interface IStatResult {
  type: string;
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: 1;
  gid: 1;
  dev: 1;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface INode {
  type: 'file' | 'dir';
  mode: number;
  content?: Uint8Array;
  mtimeMs: number;
}

function normalize(p: string): string {
  // Remove trailing slashes, collapse multiples, ensure leading /
  const parts = p.split('/').filter(Boolean);
  return '/' + parts.join('/');
}

function dirname(p: string): string {
  const norm = normalize(p);
  const idx = norm.lastIndexOf('/');
  return idx <= 0 ? '/' : norm.slice(0, idx);
}

function makeStat(node: INode, ino: number): IStatResult {
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
export class MemFS {
  private _nodes = new Map<string, INode>();
  private _nextIno = 1;

  /**
   * The promises-based API surface consumed by isomorphic-git.
   *
   * isomorphic-git's FileSystem constructor checks:
   *   Object.getOwnPropertyDescriptor(fs, 'promises')
   * If `promises` is an enumerable own property, it calls
   *   bindFs(this, fs.promises)
   * Otherwise it calls bindFs(this, fs) and expects readFile etc.
   * directly on `fs`.
   *
   * Class getters are non-enumerable, so isomorphic-git falls through
   * to the else branch and looks for readFile/writeFile/… directly on `this`.
   * We expose them as public properties so `.bind()` works.
   */
  readFile: (filepath: string, opts?: { encoding?: string }) => Promise<Uint8Array | string>;
  writeFile: (filepath: string, data: Uint8Array | string, opts?: { mode?: number; encoding?: string }) => Promise<void>;
  unlink: (filepath: string) => Promise<void>;
  readdir: (filepath: string) => Promise<string[]>;
  mkdir: (filepath: string, opts?: { recursive?: boolean }) => Promise<void>;
  rmdir: (filepath: string) => Promise<void>;
  stat: (filepath: string) => Promise<IStatResult>;
  lstat: (filepath: string) => Promise<IStatResult>;
  readlink: (filepath: string) => Promise<string>;
  symlink: (target: string, filepath: string) => Promise<void>;
  chmod: (filepath: string, mode: number) => Promise<void>;

  constructor() {
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
  get promises(): {
    readFile: Function;
    writeFile: Function;
    unlink: Function;
    readdir: Function;
    mkdir: Function;
    rmdir: Function;
    stat: Function;
    lstat: Function;
    readlink: Function;
    symlink: Function;
    chmod: Function;
  } {
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

  private _ensureParentDirs(p: string): void {
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

  private async _readFile(
    filepath: string,
    opts?: { encoding?: string }
  ): Promise<Uint8Array | string> {
    const p = normalize(filepath);
    const node = this._nodes.get(p);
    if (!node || node.type !== 'file') {
      throw Object.assign(new Error(`ENOENT: no such file '${p}'`), {
        code: 'ENOENT',
      });
    }
    const data = node.content ?? new Uint8Array(0);
    if (opts?.encoding === 'utf8') {
      return new TextDecoder().decode(data);
    }
    return data;
  }

  private async _writeFile(
    filepath: string,
    data: Uint8Array | string,
    opts?: { mode?: number; encoding?: string }
  ): Promise<void> {
    const p = normalize(filepath);
    this._ensureParentDirs(p);
    const content =
      typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const existing = this._nodes.get(p);
    this._nodes.set(p, {
      type: 'file',
      mode: opts?.mode ?? existing?.mode ?? 0o644,
      content,
      mtimeMs: Date.now(),
    });
  }

  private async _unlink(filepath: string): Promise<void> {
    const p = normalize(filepath);
    if (!this._nodes.has(p)) {
      throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
    }
    this._nodes.delete(p);
  }

  private async _readdir(filepath: string): Promise<string[]> {
    const p = normalize(filepath);
    const node = this._nodes.get(p);
    if (!node || node.type !== 'dir') {
      throw Object.assign(new Error(`ENOTDIR: '${p}'`), { code: 'ENOTDIR' });
    }
    const prefix = p === '/' ? '/' : p + '/';
    const entries = new Set<string>();
    for (const key of this._nodes.keys()) {
      if (key === p) continue;
      if (key.startsWith(prefix)) {
        // direct child only
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0];
        if (name) entries.add(name);
      }
    }
    return Array.from(entries);
  }

  private async _mkdir(
    filepath: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    const p = normalize(filepath);
    if (opts?.recursive) {
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

  private async _rmdir(filepath: string): Promise<void> {
    const p = normalize(filepath);
    this._nodes.delete(p);
  }

  private async _stat(filepath: string): Promise<IStatResult> {
    const p = normalize(filepath);
    const node = this._nodes.get(p);
    if (!node) {
      throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
    }
    return makeStat(node, this._nextIno++);
  }

  private async _readlink(_filepath: string): Promise<string> {
    throw Object.assign(new Error('ENOSYS: readlink'), { code: 'ENOSYS' });
  }

  private async _symlink(
    _target: string,
    _filepath: string
  ): Promise<void> {
    throw Object.assign(new Error('ENOSYS: symlink'), { code: 'ENOSYS' });
  }

  private async _chmod(filepath: string, mode: number): Promise<void> {
    const p = normalize(filepath);
    const node = this._nodes.get(p);
    if (!node) {
      throw Object.assign(new Error(`ENOENT: '${p}'`), { code: 'ENOENT' });
    }
    node.mode = mode;
  }
}
