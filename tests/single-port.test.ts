import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

async function availablePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function assertHmrConnection(base: string, token: string) {
  const url = new URL(base);
  url.protocol = 'ws:';
  url.searchParams.set('token', token);
  const socket = new WebSocket(url, 'vite-hmr');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('同端口 HMR 连接超时')), 5000);
      socket.addEventListener('error', () => reject(new Error('同端口 HMR 连接失败')), { once: true });
      socket.addEventListener('close', () => reject(new Error('HMR 就绪前连接已关闭')), { once: true });
      socket.addEventListener('message', event => {
        try { resolve(JSON.parse(String(event.data))); }
        catch (error) { reject(error); }
      }, { once: true });
    });
    assert.deepEqual(message, { type: 'connected' });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

async function assertModuleGraph(base: string, main: string) {
  const visited = new Set<string>(['/main.tsx']);
  let modules = [{ path: '/main.tsx', source: main }];
  while (modules.length) {
    const pending = new Set<string>();
    for (const { path, source } of modules) {
      for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?(['"])([^'"]+)\1/g)) {
        const specifier = match[2];
        if (!specifier.startsWith('/') && !specifier.startsWith('.')) continue;
        const url = new URL(specifier, `${base}${path}`);
        assert.equal(url.origin, base, '模块必须从开发服务器加载');
        const target = url.pathname + url.search;
        if (!visited.has(target)) pending.add(target);
      }
    }
    assert(visited.size + pending.size <= 150, '模块依赖图超出预期大小');
    modules = await Promise.all([...pending].map(async path => {
      visited.add(path);
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, `模块不可用：${path} (${response.statusText})`);
      assert.match(response.headers.get('content-type') ?? '', /javascript/, path);
      return { path, source: await response.text() };
    }));
  }
  assert(visited.has('/App.tsx'));
  assert(visited.has('/styles.css'));
  assert([...visited].some(path => /\/deps\/react\.js\?v=/.test(path)), '必须验证实际预构建依赖');
}

test('开发页面、模块、HMR 和 API 共用一个端口，未知 API 保持 JSON 404', { timeout: 45000 }, async t => {
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Only inherit OS essentials; never load the developer's .env or credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', 'index.ts', '--dev'], {
    cwd: resolve(root, 'src/server'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, DOTENV_CONFIG_PATH: devNull, NODE_ENV: 'test', NO_COLOR: '1',
      HOST: '127.0.0.1', PORT: String(port), STORAGE_DRIVER: 'local',
      LOGIN_SERVICE_URL: 'http://127.0.0.1:1', SERVICE_TOKEN: 'single-port-test-token' },
  });
  let output = '';
  let spawnError: Error | undefined;
  let didClose = false;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => { didClose = true; resolve(); }));
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
  }
  t.after(async () => {
    if (!didClose) {
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await closed; }
      finally { clearTimeout(forceKill); }
    }
    if (child.pid !== undefined) {
      const cacheRoot = resolve(root, 'src/frontend/node_modules/.vite-test');
      const cache = resolve(cacheRoot, String(child.pid));
      assert.equal(dirname(cache), cacheRoot);
      await rm(cache, { recursive: true, force: true });
    }
  });

  const deadline = Date.now() + 30000;
  while (true) {
    if (spawnError) throw spawnError;
    assert(!didClose, `开发服务器提前退出：\n${output}`);
    assert(Date.now() < deadline, `开发服务器启动超时：\n${output}`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      await response.text();
      if (response.ok) break;
    } catch { /* Wait until the child binds its HTTP listener. */ }
    await delay(100);
  }

  const [page, main, client, health, missing] = await Promise.all(
    ['/', '/main.tsx', '/@vite/client', '/api/health', '/api/does-not-exist']
      .map(path => fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) })),
  );
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, /src="\/@vite\/client"/);
  assert.match(html, /src="\/main\.tsx"/);

  assert.equal(main.status, 200);
  assert.match(main.headers.get('content-type') ?? '', /javascript/);
  const javascript = await main.text();
  assert.match(javascript, /createRoot/);
  assert.doesNotMatch(javascript, /<StrictMode>|<App\s*\/>/);
  await assertModuleGraph(base, javascript);

  assert.equal(client.status, 200);
  assert.match(client.headers.get('content-type') ?? '', /javascript/);
  const viteClient = await client.text();
  const tokenMatch = /const wsToken = ("(?:\\.|[^"\\])*")/.exec(viteClient);
  assert(tokenMatch, 'Vite 客户端必须注入 HMR token');
  const portMatch = /const hmrPort = (null|\d+)/.exec(viteClient);
  assert(portMatch, 'Vite 客户端必须声明 HMR 端口');
  assert([null, port].includes(JSON.parse(portMatch[1]) as number | null), 'HMR 客户端必须使用当前 HTTP 端口');

  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await health.json(), { ok: true, storage: 'local', simulation: true });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await missing.json(), { error: '接口不存在。' });
  // The project root is outside the frontend root; check Vite's absolute-file route.
  // The tracked example guarantees coverage even when no local .env exists.
  const privateFiles = ['.env.example'];
  if (existsSync(resolve(root, '.env'))) privateFiles.push('.env');
  for (const file of privateFiles) {
    const path = resolve(root, file).replaceAll('\\', '/');
    const denied = await fetch(`${base}/@fs/${encodeURI(path)}`, { signal: AbortSignal.timeout(10000) });
    await denied.body?.cancel();
    assert.equal(denied.status, 403, `${file} must not be served`);
  }
  await assertHmrConnection(base, JSON.parse(tokenMatch[1]) as string);
});
