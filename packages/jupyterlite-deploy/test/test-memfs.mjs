/**
 * Integration tests for MemFS + isomorphic-git.
 *
 * Run:  node test/test-memfs.mjs
 *
 * These tests verify that the MemFS implementation is compatible with
 * isomorphic-git's FileSystem constructor (which calls .bind() on
 * every fs method), and that basic git operations work in-memory.
 */

import git from 'isomorphic-git';
import { MemFS } from '../lib/memfs.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

async function assertRejects(fn, message) {
  try {
    await fn();
    console.error(`  FAIL: ${message} (did not throw)`);
    failed++;
  } catch {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

// ── Test 1: MemFS basic file ops ──────────────────────────────────────
console.log('\n=== Test 1: MemFS basic operations ===');
{
  const fs = new MemFS();

  // mkdir + writeFile + readFile
  await fs.mkdir('/test');
  await fs.writeFile('/test/hello.txt', new TextEncoder().encode('hello'));
  const data = await fs.readFile('/test/hello.txt');
  assert(data instanceof Uint8Array, 'readFile returns Uint8Array');
  assert(new TextDecoder().decode(data) === 'hello', 'readFile returns correct content');

  // readFile with utf8 encoding
  const text = await fs.readFile('/test/hello.txt', { encoding: 'utf8' });
  assert(text === 'hello', 'readFile with utf8 returns string');

  // stat
  const fileStat = await fs.stat('/test/hello.txt');
  assert(fileStat.isFile(), 'stat reports file');
  assert(!fileStat.isDirectory(), 'stat reports not directory');

  const dirStat = await fs.stat('/test');
  assert(dirStat.isDirectory(), 'stat reports directory');
  assert(!dirStat.isFile(), 'stat reports not file');

  // readdir
  const entries = await fs.readdir('/test');
  assert(entries.length === 1, 'readdir returns 1 entry');
  assert(entries[0] === 'hello.txt', 'readdir returns correct name');

  // unlink
  await fs.unlink('/test/hello.txt');
  await assertRejects(
    () => fs.readFile('/test/hello.txt'),
    'readFile after unlink throws ENOENT'
  );

  // stat on missing file
  await assertRejects(
    () => fs.stat('/missing'),
    'stat on missing path throws ENOENT'
  );
}

// ── Test 2: MemFS methods are bindable (isomorphic-git compat) ────────
console.log('\n=== Test 2: MemFS methods are bindable (isomorphic-git compat) ===');
{
  const fs = new MemFS();

  const methods = [
    'readFile', 'writeFile', 'unlink', 'readdir', 'mkdir',
    'rmdir', 'stat', 'lstat', 'readlink', 'symlink', 'chmod'
  ];

  for (const method of methods) {
    assert(typeof fs[method] === 'function', `fs.${method} is a function`);
    assert(typeof fs[method].bind === 'function', `fs.${method}.bind exists`);

    // Verify bind produces a working function
    const bound = fs[method].bind(fs);
    assert(typeof bound === 'function', `fs.${method}.bind(fs) returns function`);
  }
}

// ── Test 3: isomorphic-git init ───────────────────────────────────────
console.log('\n=== Test 3: isomorphic-git init ===');
{
  const fs = new MemFS();
  const dir = '/repo';

  // git.init should work without throwing
  await git.init({ fs, dir });

  // Verify .git directory was created
  const stat = await fs.stat('/repo/.git');
  assert(stat.isDirectory(), '.git directory created by git.init');

  const entries = await fs.readdir('/repo/.git');
  assert(entries.includes('HEAD'), '.git/HEAD exists');
  assert(entries.includes('objects'), '.git/objects exists');
  assert(entries.includes('refs'), '.git/refs exists');
}

// ── Test 4: isomorphic-git full workflow (init → add → commit) ────────
console.log('\n=== Test 4: isomorphic-git full workflow (init → add → commit) ===');
{
  const fs = new MemFS();
  const dir = '/repo';

  await git.init({ fs, dir });

  // Write a file
  await fs.writeFile(dir + '/index.html', new TextEncoder().encode('<h1>Hello</h1>'));
  await fs.writeFile(dir + '/.nojekyll', new Uint8Array(0));

  // Stage files
  await git.add({ fs, dir, filepath: 'index.html' });
  await git.add({ fs, dir, filepath: '.nojekyll' });

  // Commit
  const sha = await git.commit({
    fs,
    dir,
    message: 'Initial commit',
    author: { name: 'Test', email: 'test@test.com' },
  });

  assert(typeof sha === 'string', 'commit returns a SHA string');
  assert(sha.length === 40, 'SHA is 40 hex chars');

  // Read the commit back
  const log = await git.log({ fs, dir, depth: 1 });
  assert(log.length === 1, 'git log returns 1 commit');
  assert(log[0].commit.message === 'Initial commit\n', 'commit message matches');
  assert(log[0].commit.author.name === 'Test', 'author name matches');
}

// ── Test 5: isomorphic-git addRemote + listRemotes ────────────────────
console.log('\n=== Test 5: isomorphic-git addRemote + listRemotes ===');
{
  const fs = new MemFS();
  const dir = '/repo';

  await git.init({ fs, dir });
  await git.addRemote({
    fs, dir,
    remote: 'origin',
    url: 'https://github.com/test/repo.git',
  });

  const remotes = await git.listRemotes({ fs, dir });
  assert(remotes.length === 1, '1 remote configured');
  assert(remotes[0].remote === 'origin', 'remote name is origin');
  assert(remotes[0].url === 'https://github.com/test/repo.git', 'remote URL matches');
}

// ── Test 6: MemFS nested directories ──────────────────────────────────
console.log('\n=== Test 6: MemFS nested directories ===');
{
  const fs = new MemFS();

  // _ensureParentDirs via writeFile
  await fs.writeFile('/a/b/c/file.txt', new TextEncoder().encode('deep'));

  const stat = await fs.stat('/a/b/c');
  assert(stat.isDirectory(), 'intermediate dirs created');

  const data = await fs.readFile('/a/b/c/file.txt');
  assert(new TextDecoder().decode(data) === 'deep', 'deep file readable');

  // readdir at various levels
  const rootEntries = await fs.readdir('/');
  assert(rootEntries.includes('a'), 'root contains a');

  const aEntries = await fs.readdir('/a');
  assert(aEntries.includes('b'), '/a contains b');
}

// ── Test 7: isomorphic-git status after add ───────────────────────────
console.log('\n=== Test 7: isomorphic-git status ===');
{
  const fs = new MemFS();
  const dir = '/repo';

  await git.init({ fs, dir });
  await fs.writeFile(dir + '/file.txt', new TextEncoder().encode('content'));

  // Before add: status should be 'absent' or '*added'
  const statusBefore = await git.status({ fs, dir, filepath: 'file.txt' });
  assert(statusBefore === '*added', `status before add: "${statusBefore}" === "*added"`);

  await git.add({ fs, dir, filepath: 'file.txt' });

  const statusAfter = await git.status({ fs, dir, filepath: 'file.txt' });
  assert(statusAfter === 'added', `status after add: "${statusAfter}" === "added"`);
}

// ── Test 8: Multiple files commit + log ───────────────────────────────
console.log('\n=== Test 8: Multiple files and nested dirs in a commit ===');
{
  const fs = new MemFS();
  const dir = '/repo';

  await git.init({ fs, dir });

  // Simulate a JupyterLite deploy structure
  const files = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'build/app.js', content: 'console.log("app")' },
    { path: 'files/notebook.ipynb', content: '{"cells": []}' },
    { path: 'files/data/test.csv', content: 'a,b\n1,2' },
    { path: '.nojekyll', content: '' },
  ];

  for (const f of files) {
    const parts = f.path.split('/');
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      try { await fs.mkdir(cur); } catch { /* exists */ }
    }
    await fs.writeFile(
      dir + '/' + f.path,
      new TextEncoder().encode(f.content)
    );
    await git.add({ fs, dir, filepath: f.path });
  }

  const sha = await git.commit({
    fs,
    dir,
    message: 'Deploy JupyterLite site',
    author: { name: 'Deploy Bot', email: 'deploy@example.com' },
  });

  assert(typeof sha === 'string' && sha.length === 40, 'multi-file commit SHA valid');

  // Verify files in the tree
  const readBack = await fs.readFile(
    dir + '/files/data/test.csv',
    { encoding: 'utf8' }
  );
  assert(readBack === 'a,b\n1,2', 'nested file content preserved');
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
}
