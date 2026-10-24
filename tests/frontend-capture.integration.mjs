// Run with node --test tests/frontend-capture.integration.mjs.
// Uses existing PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_EXECUTABLE, never production APIs.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(repository, 'src/frontend');
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'));
let chromium;
let unavailable = '';
try {
  const modulePath = process.env.PLAYWRIGHT_MODULE || frontendRequire.resolve('playwright');
  ({ chromium } = await import(modulePath.startsWith('file:') ? modulePath : pathToFileURL(path.resolve(modulePath)).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error();
} catch { unavailable = 'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing browser dependencies.'; }

test('抓号接收后立即显示扫码成功，隐藏二维码和刷新，并保留游戏登录失败状态',
  { skip: unavailable || false, timeout: 60_000 }, async t => {
  const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(frontendRequire.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(frontendRequire.resolve('@tailwindcss/vite')).href);
  const emptyEnv = await mkdtemp(path.join(os.tmpdir(), 'naruto-capture-ui-'));
  const server = await createServer({ configFile: false, root: frontendRoot, envDir: emptyEnv,
    plugins: [react(), tailwindcss()], resolve: { alias: { '@': frontendRoot } },
    server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const [source, ending] of [['run', 'failed'], ['session', 'failed'], ['session', 'expired']]) await t.test(`${source}/${ending}`, async () => {
      const context = await browser.newContext();
      let captured = false, failed = false;
      const errors = [], requests = [];
      const at = new Date().toISOString();
      const task = { id: '11111111-1111-4111-8111-111111111111', status: 'qr_ready', createdAt: at,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), simulation: true, showGetButton: false };
      const session = () => ({ ...task, ...(source === 'session' && captured ? { scanCaptured: true } : {}),
        ...(failed ? { status: ending, showGetButton: true, errorCode: 'login_failed' } : {}) });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        requests.push({ path: url.pathname, method: request.method() });
        let body;
        if (url.pathname === '/api/health') body = { ok: true, environment: 'development' };
        else if (url.pathname === '/api/auth/me') body = { user: { id: 'capture-ui-user', username: '测试用户', isAdmin: false } };
        else if (url.pathname === '/api/task-runs/latest') body = { task: null };
        else if (url.pathname === '/api/login-sessions/active') body = { session: failed ? null : session(), showGetButton: failed };
        else if (url.pathname === `/api/login-sessions/${task.id}`) body = session();
        else if (url.pathname === `/api/login-sessions/${task.id}/qr`) return route.fulfill({ status: 200, contentType: 'image/png',
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7nwAAAAASUVORK5CYII=', 'base64') });
        else if (url.pathname === `/api/task-runs/${task.id}/events`) body = {
          task, run: { taskId: task.id, status: source === 'run' && failed ? ending : 'waiting_scan', updatedAt: at,
            startedAt: null, finishedAt: source === 'run' && failed ? at : null,
            ...(source === 'run' && captured ? { scanCapturedAt: at } : {}), ...(failed ? { errorCode: 'login_failed' } : {}) },
          logs: [], nextCursor: url.searchParams.get('after') || '0-0', hasMore: false, truncated: false };
        else { errors.push(`Unexpected API: ${url.pathname}`); return route.fulfill({ status: 404, json: {} }); }
        return route.fulfill({ status: 200, json: body }).catch(() => {});
      });
      try {
        await page.goto(origin, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).click();
        const card = page.locator('.login-card');
        await card.getByRole('img', { name: /登录二维码/ }).waitFor();
        captured = true;
        await card.getByText('扫码成功', { exact: true }).first().waitFor();
        assert.equal(await card.getByRole('img', { name: /登录二维码/ }).count(), 0);
        assert.equal(await page.getByRole('button', { name: '刷新二维码', exact: true }).count(), 0);
        assert.equal(await card.getAttribute('data-authorized'), 'false');
        const progress = page.getByLabel('任务执行进度', { exact: true });
        await progress.locator('[data-stage="qr"][data-state="completed"]').waitFor();
        await progress.locator('[data-stage="script"][data-state="pending"]').waitFor();
        failed = true;
        await card.getByText('扫码已完成，但游戏登录未完成，脚本尚未开始，请重新申请。', { exact: true }).waitFor();
        await progress.locator('[data-stage="script"][data-state="failed"]').waitFor();
        assert.equal(await page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).isEnabled(), true);
        assert.equal(requests.filter(request => request.method === 'POST').length, 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    await rmdir(emptyEnv);
  }
});
