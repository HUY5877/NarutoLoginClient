import { strict as assert } from 'node:assert';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { releasePort } from '../src/server/port.js';

const execFileAsync = promisify(execFile);
const host = '127.0.0.1';
const root = fileURLToPath(new URL('../', import.meta.url));

function isolatedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function trackChild(t: TestContext, child: ChildProcess, afterClose?: () => Promise<void>) {
  let didClose = false;
  let output = '';
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => { didClose = true; resolve(); }));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
  }
  t.after(async () => {
    if (!didClose) {
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 10000 });
        } catch (error) { if (!didClose) throw error; }
      } else child.kill('SIGKILL');
      await bounded(closed, 5000, `测试子进程未退出：${child.pid}\n${output}`);
    }
    await afterClose?.();
  });
  return {
    child, closed,
    get didClose() { return didClose; },
    get output() { return output; },
    get spawnError() { return spawnError; },
  };
}

async function removeViteCache(pid: number | undefined) {
  if (pid === undefined) return;
  assert(Number.isSafeInteger(pid) && pid > 0);
  const cacheRoot = resolve(root, 'node_modules/.vite-test');
  const cache = resolve(cacheRoot, String(pid));
  assert.equal(dirname(cacheRoot), resolve(root, 'node_modules'));
  assert.equal(dirname(cache), cacheRoot);
  await rm(cache, { recursive: true, force: true });
}

async function windowsListenerPid(port: number) {
  assert(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 4300);
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-NetTCPConnection -State Listen -LocalAddress '${host}' -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 10000 });
  const result: unknown = JSON.parse(stdout);
  const pids = Array.isArray(result) ? result : [result];
  assert.equal(pids.length, 1, '临时端口必须只有一个测试服务监听进程');
  const pid: unknown = pids[0];
  assert(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
  return pid;
}

async function listener(t: TestContext) {
  const child = spawn(process.execPath, ['-e', `
    const server = require('node:net').createServer(socket => socket.end());
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `], { windowsHide: true, env: isolatedEnv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const tracked = trackChild(t, child);
  const [message] = await bounded(once(child, 'message'), 5000, '测试监听进程启动超时');
  const port = (message as { port: number }).port;
  assert(Number.isInteger(port) && port > 0 && port !== 4300, '仅允许操作测试子进程的临时端口');
  return Object.assign(tracked, { port });
}

async function assertBindable(port: number) {
  const server = createServer();
  try {
    server.listen(port, host);
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

async function assertOccupied(port: number) {
  const server = createServer();
  try {
    server.listen(port, host);
    await assert.rejects(once(server, 'listening'), { code: 'EADDRINUSE' });
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function waitForHealth(server: ReturnType<typeof trackChild>, port: number) {
  const deadline = Date.now() + 30000;
  while (true) {
    if (server.spawnError) throw server.spawnError;
    assert(!server.didClose, `测试开发服务提前退出：\n${server.output}`);
    assert(Date.now() < deadline, `测试开发服务启动超时：\n${server.output}`);
    try {
      const response = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      await response.text();
      if (response.ok) return;
    } catch { /* Wait for the isolated development server to start listening. */ }
    await delay(100);
  }
}

test('空闲端口清理后仍可监听，重复清理不产生副作用', { timeout: 10000 }, async () => {
  const port = await assertBindable(0);
  assert.notEqual(port, 4300);
  await releasePort(host, port);
  await releasePort(host, port);
  assert.equal(await assertBindable(port), port);
});

test('只终止目标端口的监听进程，保留其他端口进程', { timeout: 30000 }, async t => {
  const target = await listener(t);
  const unrelated = await listener(t);
  assert.notEqual(target.port, unrelated.port);
  await releasePort(host, target.port);
  await bounded(target.closed, 5000, `占用目标端口的进程未退出：\n${target.output}`);
  assert.equal(await assertBindable(target.port), target.port);
  assert.equal(unrelated.child.exitCode, null);
  assert.equal(unrelated.child.signalCode, null);
  await assertOccupied(unrelated.port);
});

test('无效端口在执行清理前被拒绝，现有测试监听进程不受影响', { timeout: 15000 }, async t => {
  const existing = await listener(t);
  for (const port of [-1, 0, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(releasePort(host, port), `应拒绝无效端口 ${port}`);
  }
  assert.equal(existing.child.exitCode, null);
  assert.equal(existing.child.signalCode, null);
  await assertOccupied(existing.port);
});

test('Windows 重启开发服务释放配置端口，并退出旧 tsx watch 父进程', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  const port = await assertBindable(0);
  assert.notEqual(port, 4300);
  const cli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const env = { ...isolatedEnv(), DOTENV_CONFIG_PATH: devNull, NODE_ENV: 'test', NO_COLOR: '1',
    HOST: host, PORT: String(port), STORAGE_DRIVER: 'local',
    LOGIN_SERVICE_URL: 'http://127.0.0.1:1', SERVICE_TOKEN: 'port-release-regression-test-token' };
  const child = spawn(process.execPath, [cli, 'watch', 'src/server/index.ts', '--dev'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  let listenerPid: number | undefined;
  const watcher = trackChild(t, child, () => removeViteCache(listenerPid));
  await waitForHealth(watcher, port);
  // Record this listener only; other tests can create their own caches concurrently.
  listenerPid = await windowsListenerPid(port);

  // Exercise the real startup path so forgetting the releasePort call also fails.
  const replacementChild = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts', '--dev'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  const replacement = trackChild(t, replacementChild, () => removeViteCache(replacementChild.pid));
  await bounded(watcher.closed, 15000,
    `tsx watch 父进程仍存活，文件变化可能重新抢占端口：\n${watcher.output}`);
  await waitForHealth(replacement, port);
  assert.equal(replacement.didClose, false);
  await assertOccupied(port);
});
