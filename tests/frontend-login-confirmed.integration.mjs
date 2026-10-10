// Focused browser checks. All APIs are mocked and Vite never loads project .env files.
// Provide existing PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE when not installed locally.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/frontend');
const require = createRequire(path.join(root, 'package.json'));
let chromium;
let skip = '';
try {
  const entry = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright');
  ({ chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(path.resolve(entry)).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error();
} catch { skip = 'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing browser dependencies.'; }

const taskId = '11111111-1111-4111-8111-111111111111';
const oldId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7nwAAAAASUVORK5CYII=', 'base64');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  const limit = Date.now() + 5_000;
  while (!check()) { assert.ok(Date.now() < limit, 'mock request did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('QR authorization confirmation and queue expiry', { skip: skip || false, timeout: 45_000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-confirmed-empty-env-'));
  const server = await createServer({ configFile: false, root, envDir, plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    async function fixture({ old = false, sessionStatus = 'qr_ready', runStatus = 'waiting_scan' } = {}) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(6_000);
      const time = new Date().toISOString();
      const session = { id: taskId, status: sessionStatus, createdAt: time, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        simulation: true, showGetButton: false };
      const state = { status: runStatus, detailStatus: sessionStatus, detailHttpStatus: 200,
        calls: [], errors: [], oldRequested: false, oldGate: deferred() };
      page.on('pageerror', error => state.errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        state.calls.push(url.pathname);
        let body;
        if (url.pathname === '/api/auth/me') body = { user: { id: 'confirmed-user', username: '授权测试', isAdmin: false } };
        else if (url.pathname === '/api/login-sessions/active') body = { session, showGetButton: false };
        else if (url.pathname === `/api/login-sessions/${taskId}`) {
          return route.fulfill({ status: state.detailHttpStatus,
            json: { ...session, status: state.detailStatus, showGetButton: state.detailStatus === 'expired' } });
        }
        else if (url.pathname === `/api/login-sessions/${taskId}/qr`) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
        else if (url.pathname === '/api/task-runs/latest') body = { task: old ? { ...session, id: oldId } : null };
        else if (url.pathname.endsWith('/events')) {
          const id = url.pathname.split('/')[3];
          if (id === oldId) { state.oldRequested = true; await state.oldGate.promise; }
          const status = id === oldId ? 'finishing_login' : state.status;
          body = { task: { ...session, id }, run: status ? { taskId: id, status, updatedAt: time, startedAt: null, finishedAt: null,
            ...(status === 'finishing_login' ? { authorizedAt: time } : {}) } : null,
          logs: [], nextCursor: '0-0', hasMore: false, truncated: false };
        } else { state.errors.push(`Unexpected API ${url.pathname}`); return route.fulfill({ status: 404, json: {} }); }
        return route.fulfill({ status: 200, json: body }).catch(() => {});
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).waitFor();
      return { context, page, state, async close() { state.oldGate.resolve(); await context.close(); assert.deepEqual(state.errors, []); } };
    }

    for (const source of ['clock', 'api-expired', 'http-410']) {
      await t.test(`unclaimed task expiry from ${source} shows capacity message and allows retry`, async () => {
        const f = await fixture({ sessionStatus: 'queued', runStatus: null });
        try {
          await f.page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).click();
          await f.page.getByText('申请已收到，正在排队', { exact: true }).waitFor();
          if (source === 'clock') await f.page.evaluate(() => { const now = Date.now; Date.now = () => now() + 120_000; });
          else if (source === 'api-expired') f.state.detailStatus = 'expired';
          else f.state.detailHttpStatus = 410;
          await f.page.getByText('服务器可用实例紧张，请稍后再试。', { exact: true }).first().waitFor();
          const qrStage = f.page.getByLabel('任务执行进度', { exact: true }).locator('[data-stage="qr"][data-state="failed"]');
          assert.match(await qrStage.innerText(), /服务器可用实例紧张，请稍后再试/);
          assert.equal(await f.page.getByText('二维码已过期', { exact: true }).count(), 0);
          assert.equal(await f.page.getByLabel(/^剩余 \d+ 秒$/).count(), 0);
          assert.equal(await f.page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).isEnabled(), true);
        } finally { await f.close(); }
      });
    }

    for (const sessionStatus of ['queued', 'preparing_qr', 'qr_ready']) {
      await t.test(`claimed ${sessionStatus} session does not report capacity pressure at expiry`, async () => {
        const f = await fixture({ sessionStatus, runStatus: sessionStatus === 'queued' ? 'starting_emulator' : null });
        try {
          await f.page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).click();
          await f.page.getByLabel(/^剩余 \d+ 秒$/).waitFor();
          await until(() => f.state.calls.includes(`/api/task-runs/${taskId}/events`));
          await f.page.evaluate(() => { const now = Date.now; Date.now = () => now() + 120_000; });
          await f.page.getByText('二维码已过期', { exact: true }).first().waitFor();
          assert.doesNotMatch(await f.page.locator('body').innerText(), /实例紧张|排队超时/);
        } finally { await f.close(); }
      });
    }

    await t.test('matching authorization hides the real QR and countdown before the original expiry', async () => {
      const f = await fixture();
      try {
        await f.page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).click();
        const image = f.page.locator('img[src^="blob:"]');
        const countdown = f.page.getByLabel(/^剩余 \d+ 秒$/);
        await image.waitFor();
        await countdown.waitFor();
        assert.match(await image.getAttribute('alt'), /手机 QQ 扫码授权/);
        assert.doesNotMatch(await f.page.locator('body').innerText(), /模拟二维码|模拟登录演示|不能授权或登录真实账号/);
        f.state.status = 'finishing_login';
        await f.page.getByText('扫码授权已完成', { exact: true }).waitFor();
        assert.equal(await image.count(), 0);
        assert.equal(await countdown.count(), 0);
        const before = f.state.calls.filter(value => value.startsWith('/api/login-sessions')).length;
        await f.page.evaluate(() => { const now = Date.now; Date.now = () => now() + 120_000; });
        await f.page.waitForTimeout(1_100); // Exercise the existing once-per-second expiry effect.
        assert.equal(await f.page.getByText('扫码授权已完成', { exact: true }).isVisible(), true);
        assert.equal(await f.page.getByText('二维码已过期', { exact: true }).count(), 0);
        assert.equal(await countdown.count(), 0);
        assert.equal(f.state.calls.filter(value => value.startsWith('/api/login-sessions')).length, before);
      } finally { await f.close(); }
    });

    await t.test('a late authorized result for an old task cannot dismiss a new task QR', async () => {
      const f = await fixture({ old: true });
      try {
        await until(() => f.state.oldRequested);
        await f.page.getByRole('button', { name: '启动模拟器获取二维码', exact: true }).click();
        const image = f.page.locator('img[src^="blob:"]');
        await image.waitFor();
        f.state.oldGate.resolve();
        const polls = f.state.calls.filter(value => value === `/api/task-runs/${taskId}/events`).length;
        await until(() => f.state.calls.filter(value => value === `/api/task-runs/${taskId}/events`).length > polls);
        assert.equal(await image.isVisible(), true);
        assert.equal(await f.page.getByLabel(/^剩余 \d+ 秒$/).isVisible(), true);
        assert.equal(await f.page.getByText('扫码授权已完成', { exact: true }).count(), 0);
      } finally { await f.close(); }
    });
  } finally { await browser?.close(); await server.close(); await rmdir(envDir); }
});
