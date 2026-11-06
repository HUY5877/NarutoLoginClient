// All requests are intercepted; Vite uses an empty env directory and no backend.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.join(root, 'src/frontend');
const require = createRequire(path.join(frontend, 'package.json'));
let chromium;
let unavailable = '';
try {
  const modulePath = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright');
  ({ chromium } = await import(modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error('missing browser');
} catch { unavailable = 'Existing Playwright/Chromium required; no dependencies are installed.'; }
const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'recovery-user', username: '恢复测试', isAdmin: false };
const options = { equipmentStamina: false, secretRealmMode: 'all', mainTask: 'arena_weekly' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7nwAAAAASUVORK5CYII=', 'base64');
const generate = page => page.getByRole('button', { name: '启动模拟器获取二维码', exact: true });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message = 'Expected page state', timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('刷新优先恢复统一任务状态', { skip: unavailable || false, timeout: 180000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: css } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-recovery-'));
  const server = await createServer({ configFile: false, root: frontend, envDir, plugins: [react(), css()],
    resolve: { alias: { '@': frontend } }, server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    async function fixture(status = 'running_daily', mainTask = 'arena_weekly', unavailableAbortApis = null) {
      const context = await browser.newContext(unavailableAbortApis ? { viewport: { width: 390, height: 844 } } : {});
      if (unavailableAbortApis?.length) await context.addInitScript(names => {
        for (const name of names) Object.defineProperty(AbortSignal, name, { value: undefined, configurable: true });
      }, unavailableAbortApis);
      const state = { status, calls: [], errors: [], latestGate: null, eventsGate: null, fail: false, partial: false,
        expiredHeader: false, missingRun: false, captured: false, noTask: false };
      const task = () => ({ id, status: state.status === 'queued' ? 'queued' : 'qr_ready',
        createdAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + (state.expiredHeader ? -60000 : 60000)).toISOString(),
        userOptions: { ...options, mainTask }, loginType: 'android_qq', simulation: true });
      const run = () => ({ taskId: id, status: state.status, updatedAt: new Date().toISOString(),
        startedAt: ['running_daily', 'completed', 'failed', 'interrupted'].includes(state.status) ? new Date().toISOString() : null,
        finishedAt: ['completed', 'failed', 'interrupted', 'expired'].includes(state.status) ? new Date().toISOString() : null,
        ...(state.partial ? { secretRealmCompletedAt: new Date().toISOString() } : {}) });
      await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        state.calls.push(`${request.method()} ${url.pathname}`);
        let body;
        if (url.pathname === '/api/health') body = { ok: true, environment: 'test' };
        else if (url.pathname === '/api/auth/me') body = { user };
        else if (url.pathname === '/api/task-runs/latest') {
          if (state.latestGate) await state.latestGate.promise;
          if (state.fail) return route.fulfill({ status: 503, json: { error: '暂时不可用' } }).catch(() => {});
          body = { task: state.noTask ? null : task(), run: state.noTask || state.missingRun ? null : run() };
        } else if (url.pathname === `/api/task-runs/${id}/events`) {
          if (state.eventsGate) await state.eventsGate.promise;
          body = { task: task(), run: run(), logs: [], nextCursor: url.searchParams.get('after') || '0-0', hasMore: false, truncated: false };
        } else if (url.pathname === `/api/login-sessions/${id}`) body = { ...task(), runStatus: state.status,
          status: state.status === 'waiting_scan' ? 'qr_ready' : state.status, showGetButton: false, pollAfterMs: 500,
          ...(state.captured ? { scanCaptured: true } : {}) };
        else if (url.pathname === `/api/login-sessions/${id}/qr`) return route.fulfill({ status: 200, contentType: 'image/png', body: png }).catch(() => {});
        else { state.errors.push(`Unexpected ${request.method()} ${url.pathname}`); return route.fulfill({ status: 400, json: {} }).catch(() => {}); }
        await route.fulfill({ status: 200, json: body }).catch(() => {});
      });
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      page.on('pageerror', error => state.errors.push(error.message));
      return { page, state, async open() { await page.goto(origin, { waitUntil: 'domcontentloaded' }); await generate(page).waitFor(); },
        async close() { state.latestGate?.resolve(); state.eventsGate?.resolve(); await context.close(); assert.deepEqual(state.errors, []); } };
    }

    for (const absent of [[], ['any'], ['any', 'timeout']]) {
      const label = absent.length ? `missing-${absent.join('-')}` : 'normal';
      await t.test(`AbortSignal ${label} 均可恢复任务`, async () => {
        const f = await fixture('running_daily', 'arena_weekly', absent);
        try {
          await f.open();
          await until(async () => /执行中/.test(await f.page.getByLabel('任务整体状态', { exact: true }).innerText()));
          assert.equal(f.state.calls.filter(call => call.endsWith('/api/task-runs/latest')).length, 1);
          assert.equal(await f.page.getByText('任务状态暂时无法确认，请重试查询任务。', { exact: true }).count(), 0);
          assert.equal(await generate(f.page).isDisabled(), true);
          assert.equal(f.state.calls.includes('GET /api/auth/me'), true);
          assert.equal(f.state.calls.includes('GET /api/health'), true);
          assert.equal(f.state.calls.some(call => call.startsWith('POST ')), false);
        } finally { await f.close(); }
      });
    }

    for (const mainTask of ['daily', 'arena_weekly']) for (const pending of ['latestGate', 'eventsGate']) {
      await t.test(`${mainTask}等待${pending}时禁止再次申请`, async () => {
        const f = await fixture('running_daily', mainTask); f.state[pending] = gate();
        try {
          await f.open();
          await until(() => f.state.calls.some(call => call.endsWith(pending === 'latestGate' ? '/latest' : '/events')));
          assert.equal(await generate(f.page).isDisabled(), true);
          assert.equal(f.state.calls.some(call => call.startsWith('POST ')), false);
          f.state[pending].resolve();
          await until(async () => /执行中/.test(await f.page.getByLabel('任务整体状态', { exact: true }).innerText()));
          assert.equal(await generate(f.page).isDisabled(), true);
        } finally { await f.close(); }
      });
    }
    for (const status of ['queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'waiting_scan']) {
      await t.test(`${status}刷新自动恢复原申请`, async () => {
        const f = await fixture(status);
        try {
          await f.open();
          await until(() => f.state.calls.includes(`GET /api/login-sessions/${id}`));
          if (status === 'waiting_scan') await f.page.locator('img[src^="blob:"]').waitFor();
          assert.equal(await generate(f.page).isDisabled(), true);
          assert.equal(f.state.calls.some(call => call.startsWith('POST ')), false);
          assert.equal(f.state.calls.includes('GET /api/login-sessions/active'), false);
        } finally { await f.close(); }
      });
    }
    for (const status of ['failed', 'interrupted', 'expired']) {
      await t.test(`${status}刷新保留记录并允许下一次申请`, async () => {
        const f = await fixture(status, 'daily'); f.state.partial = status !== 'expired';
        try { await f.open(); await f.page.locator('#task-run-details').getByText('任务执行记录', { exact: true }).waitFor();
          await until(() => generate(f.page).isEnabled());
        } finally { await f.close(); }
      });
    }
    for (const status of ['finishing_login', 'running_daily']) {
      await t.test(`${status}恢复不受旧扫码期限影响`, async () => {
        const f = await fixture(status); f.state.expiredHeader = true;
        try {
          await f.open(); await until(async () => /执行中|正在进入游戏/.test(await f.page.getByLabel('任务整体状态', { exact: true }).innerText()));
          assert.equal(await generate(f.page).isDisabled(), true);
          assert.equal(f.state.calls.some(call => call.includes('/login-sessions')), false);
          assert.equal(await f.page.getByLabel(/^剩余 \d+ 秒$/).count(), 0);
        } finally { await f.close(); }
      });
    }
    await t.test('扫码已经收到时恢复不重新展示二维码', async () => {
      const f = await fixture('waiting_scan'); f.state.captured = true;
      try {
        await f.open(); await f.page.getByText('扫码成功', { exact: true }).first().waitFor();
        assert.equal(f.state.calls.some(call => call.endsWith('/qr')), false);
        assert.equal(await generate(f.page).isDisabled(), true);
      } finally { await f.close(); }
    });
    await t.test('存在任务但缺少运行状态时禁止申请', async () => {
      const f = await fixture(); f.state.missingRun = true;
      try {
        await f.open(); await f.page.getByRole('button', { name: '重试查询任务', exact: true }).waitFor();
        assert.equal(await generate(f.page).isDisabled(), true);
        assert.equal(f.state.calls.some(call => call.startsWith('POST ')), false);
      } finally { await f.close(); }
    });
    await t.test('本页完成保留结果，刷新已完成隐藏旧记录', async () => {
      const f = await fixture();
      try {
        await f.open(); await until(async () => /执行中/.test(await f.page.getByLabel('任务整体状态', { exact: true }).innerText()));
        f.state.status = 'completed';
        await until(async () => (await f.page.getByLabel('任务整体状态', { exact: true }).innerText()) === '任务已完成');
        assert.equal(await f.page.locator('#task-run-details').getByText('任务执行记录', { exact: true }).count(), 1);
        await f.page.reload({ waitUntil: 'networkidle' });
        assert.equal(await f.page.getByLabel('任务整体状态', { exact: true }).innerText(), '待开始');
        assert.equal(await f.page.getByText('任务执行记录', { exact: true }).count(), 0);
        assert.equal(await generate(f.page).isEnabled(), true);
      } finally { await f.close(); }
    });
    await t.test('首次查询失败保持禁用，重试成功后恢复运行状态', async () => {
      const f = await fixture(); f.state.fail = true;
      try {
        await f.open(); await f.page.getByRole('button', { name: '重试查询任务', exact: true }).waitFor();
        assert.equal(await generate(f.page).isDisabled(), true);
        f.state.fail = false; await f.page.getByRole('button', { name: '重试查询任务', exact: true }).click();
        await until(async () => /执行中/.test(await f.page.getByLabel('任务整体状态', { exact: true }).innerText()));
        assert.equal(await generate(f.page).isDisabled(), true);
      } finally { await f.close(); }
    });
    for (const previous of ['none', 'completed']) {
      await t.test(`查询失败后重试${previous}清除旧错误并回到待开始`, async () => {
        const f = await fixture(previous === 'completed' ? 'completed' : 'running_daily'); f.state.fail = true;
        try {
          await f.open(); await f.page.getByRole('button', { name: '重试查询任务', exact: true }).waitFor();
          f.state.fail = false; f.state.noTask = previous === 'none';
          await f.page.getByRole('button', { name: '重试查询任务', exact: true }).click();
          await until(() => generate(f.page).isEnabled());
          assert.equal(await f.page.getByLabel('任务整体状态', { exact: true }).innerText(), '待开始');
          assert.equal(await f.page.getByText(/任务状态暂时无法确认/).count(), 0);
          assert.equal(await f.page.getByText('任务执行记录', { exact: true }).count(), 0);
        } finally { await f.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); await rmdir(envDir); }
});
