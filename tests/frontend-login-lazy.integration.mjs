// Run with: node --test tests/frontend-login-lazy.integration.mjs
// Optional external browser dependencies: PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE.
// All APIs are intercepted. Vite uses an empty env directory and never starts the backend.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rmdir } from 'node:fs/promises';
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
  const moduleUrl = modulePath.startsWith('file:') ? modulePath : pathToFileURL(path.resolve(modulePath)).href;
  ({ chromium } = await import(moduleUrl));
  if (!chromium) throw new Error('The supplied module does not export chromium');
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!existsSync(executable)) throw new Error('Chromium executable is unavailable');
} catch {
  unavailable = 'Playwright/Chromium unavailable: set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing dependencies; no dependencies are installed by this test.';
}

const firstUser = { id: 'lazy-user-one', username: '懒加载测试用户', isAdmin: false };
const secondUser = { id: 'lazy-user-two', username: '第二位测试用户', isAdmin: false };
const sessionId = '11111111-1111-4111-8111-111111111111';
const latestId = '22222222-2222-4222-8222-222222222222';
const pendingId = '33333333-3333-4333-8333-333333333333';
const clockError = '执行服务器时间与任务服务器不同步，请同步执行服务器系统时间后重新申请。';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7nwAAAAASUVORK5CYII=', 'base64');
function session(status = 'qr_ready', expiresAt = Date.now() + 60_000) {
  return { id: sessionId, status, createdAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    simulation: true, showGetButton: false, pollAfterMs: 500 };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const callsToLogin = calls => calls.filter(call => call.path.startsWith('/api/login-sessions'));
const generate = page => page.getByRole('button', { name: '启动模拟器获取二维码', exact: true });
const equipmentStamina = page => page.getByRole('checkbox', { name: '装备栏体力刷取', exact: true });
const expandRecords = page => page.getByRole('button', { name: '展开记录', exact: true });
async function waitFor(predicate, message, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function expectStages(page, expected) {
  const progress = page.getByLabel('任务执行进度', { exact: true });
  await progress.waitFor();
  const stages = ['submission', 'qr', 'script'];
  const titles = ['提交登录申请', '二维码获取状态', '执行脚本'];
  for (const [index, stage] of stages.entries()) {
    const item = progress.locator(`[data-stage="${stage}"][data-state="${expected[index]}"]`);
    await item.waitFor();
    assert.equal(await item.getByText(new RegExp(`^${index + 1}\\.\\s*${titles[index]}$`)).count(), 1);
  }
  assert.equal(await progress.getByRole('listitem').count(), 3);
}

test('QR sessions load only after an explicit click', { skip: unavailable || false, timeout: 90_000 }, async t => {
  const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(frontendRequire.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(frontendRequire.resolve('@tailwindcss/vite')).href);
  const emptyEnv = await mkdtemp(path.join(os.tmpdir(), 'naruto-login-lazy-env-'));
  const server = await createServer({ configFile: false, root: frontendRoot, envDir: emptyEnv,
    plugins: [react(), tailwindcss()], resolve: { alias: { '@': frontendRoot } },
    server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture() {
      const context = await browser.newContext();
      const state = { user: firstUser, calls: [], errors: [], active: () => ({ session: null, showGetButton: true }),
        submit: () => session('queued'), submitStatus: 200, detail: () => session(), afterQr: null, qrResponse: null,
        latest: () => ({ task: { ...session('expired', Date.now() - 60_000), id: latestId } }),
        events: (taskId, url) => {
          const now = new Date().toISOString();
          return { task: { ...session('expired', Date.now() - 60_000), id: taskId },
            run: { taskId, status: 'starting_emulator', updatedAt: now, startedAt: null, finishedAt: null },
            logs: [], nextCursor: url.searchParams.get('after') || '0-0', hasMore: false, truncated: false };
        } };
      context.on('page', current => current.on('pageerror', error => state.errors.push(error.message)));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const request = route.request();
        state.calls.push({ path: url.pathname, method: request.method(), query: url.search,
          body: request.method() === 'POST' ? request.postDataJSON() : null });
        let body;
        if (url.pathname === '/api/auth/me') body = { user: state.user };
        else if (url.pathname === '/api/login-sessions/active') body = await state.active(request);
        else if (url.pathname === '/api/login-sessions' && request.method() === 'POST') body = await state.submit(request);
        else if (url.pathname === `/api/login-sessions/${sessionId}`) body = await state.detail(request);
        else if (url.pathname === `/api/login-sessions/${sessionId}/qr`) {
          if (state.afterQr) await state.afterQr();
          if (state.qrResponse) return route.fulfill(state.qrResponse).catch(() => {});
          return route.fulfill({ status: 200, contentType: 'image/png', body: png }).catch(() => {});
        } else if (url.pathname === '/api/task-runs/latest') {
          body = await state.latest();
        } else if (/^\/api\/task-runs\/[^/]+\/events$/.test(url.pathname)) {
          const taskId = url.pathname.split('/')[3];
          body = await state.events(taskId, url);
        } else {
          state.errors.push(`Unexpected mocked API: ${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 404, json: {} });
        }
        const status = url.pathname === '/api/login-sessions' && request.method() === 'POST' ? state.submitStatus : 200;
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      return { context, page, state, async open() { await page.goto(origin, { waitUntil: 'networkidle' }); await generate(page).waitFor(); },
        async close() { await context.close(); assert.deepEqual(state.errors, []); } };
    }

    await t.test('initial visit, reload, new tab, focus and storage do not request QR sessions; logs keep polling', async () => {
      const f = await fixture();
      try {
        await f.open();
        assert.equal(await generate(f.page).isEnabled(), true);
        assert.deepEqual(callsToLogin(f.state.calls), []);
        await f.page.reload({ waitUntil: 'networkidle' });
        await generate(f.page).waitFor();
        const tab = await f.context.newPage();
        await tab.goto(origin, { waitUntil: 'networkidle' });
        await generate(tab).waitFor();
        await f.page.evaluate(({ userId, pendingId }) => {
          const now = Date.now();
          window.dispatchEvent(new Event('focus'));
          const value = JSON.stringify({ requestId: pendingId, createdAt: now, expiresAt: now + 120_000 });
          localStorage.setItem(`naruto-login:pending:${userId}`, value);
          window.dispatchEvent(new StorageEvent('storage', { key: `naruto-login:pending:${userId}`, newValue: value }));
          window.dispatchEvent(new StorageEvent('storage', { key: 'naruto-login:session-changed', newValue: `${userId}:${now}` }));
        }, { userId: firstUser.id, pendingId });
        const logsBefore = f.state.calls.filter(call => call.path.endsWith('/events')).length;
        await waitFor(() => f.state.calls.filter(call => call.path.endsWith('/events')).length > logsBefore, 'Execution logs should continue polling');
        assert.deepEqual(callsToLogin(f.state.calls), []);
        assert.equal(await generate(f.page).isEnabled(), true);
        assert.ok(f.state.calls.some(call => call.path === '/api/auth/me'));
      } finally { await f.close(); }
    });

    await t.test('click queries active first and restores an existing QR without POST', async () => {
      const f = await fixture();
      try {
        f.state.active = () => ({ session: session(), showGetButton: false });
        await f.open();
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.deepEqual(callsToLogin(f.state.calls).map(call => [call.method, call.path]), [
          ['GET', '/api/login-sessions/active'], ['GET', `/api/login-sessions/${sessionId}/qr`],
        ]);
      } finally { await f.close(); }
    });

    for (const enabled of [true, false]) {
      await t.test(`equipment stamina selection submits ${enabled} inside userOptions`, async () => {
        const f = await fixture();
        try {
          f.state.submit = request => ({ ...session('queued'), userOptions: request.postDataJSON().userOptions });
          f.state.detail = () => ({ ...session(), userOptions: { equipmentStamina: enabled } });
          await f.open();
          assert.equal(await equipmentStamina(f.page).isChecked(), true);
          assert.equal(await equipmentStamina(f.page).isEnabled(), true);
          await equipmentStamina(f.page).setChecked(enabled);
          if (!enabled) {
            await f.page.setViewportSize({ width: 390, height: 844 });
            const screenshotPath = path.join(repository, '.data/login-lazy-integration/equipment-stamina-mobile.png');
            await mkdir(path.dirname(screenshotPath), { recursive: true });
            await f.page.screenshot({ path: screenshotPath, fullPage: true });
            t.diagnostic(`Equipment stamina selection screenshot: ${screenshotPath}`);
          }
          await generate(f.page).click();
          await f.page.locator('img[src^="blob:"]').waitFor();
          const posts = callsToLogin(f.state.calls).filter(call => call.method === 'POST');
          assert.equal(posts.length, 1);
          assert.deepEqual(posts[0].body.userOptions, { equipmentStamina: enabled });
          assert.deepEqual(Object.keys(posts[0].body).sort(), ['requestId', 'userOptions']);
          assert.equal(await equipmentStamina(f.page).isChecked(), enabled);
          assert.equal(await equipmentStamina(f.page).isDisabled(), true);
        } finally { await f.close(); }
      });
    }

    await t.test('an existing session replaces the new selection with its actual saved options', async () => {
      const f = await fixture();
      try {
        f.state.active = () => ({ session: { ...session(), userOptions: { equipmentStamina: false } }, showGetButton: false });
        await f.open();
        assert.equal(await equipmentStamina(f.page).isChecked(), true);
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(await equipmentStamina(f.page).isChecked(), false);
        assert.equal(await equipmentStamina(f.page).isDisabled(), true);
        assert.equal(callsToLogin(f.state.calls).filter(call => call.method === 'POST').length, 0);
      } finally { await f.close(); }
    });

    await t.test('pending intent stores selection atomically and restores it locked after reload', async () => {
      const f = await fixture();
      const gate = deferred();
      try {
        let submissions = 0;
        f.state.submit = async request => {
          if (++submissions === 1) await gate.promise;
          return { ...session('queued'), userOptions: request.postDataJSON().userOptions };
        };
        f.state.detail = () => ({ ...session(), userOptions: { equipmentStamina: false } });
        await f.open();
        await equipmentStamina(f.page).uncheck();
        await generate(f.page).click();
        await waitFor(() => callsToLogin(f.state.calls).some(call => call.method === 'POST'), 'First request should be submitted');
        const intent = await f.page.evaluate(userId => JSON.parse(localStorage.getItem(`naruto-login:pending:${userId}`)), firstUser.id);
        assert.deepEqual(intent.userOptions, { equipmentStamina: false });
        assert.equal(await equipmentStamina(f.page).isDisabled(), true);
        await f.page.reload({ waitUntil: 'networkidle' });
        await generate(f.page).waitFor();
        assert.equal(await equipmentStamina(f.page).isChecked(), false);
        assert.equal(await equipmentStamina(f.page).isDisabled(), true);
        assert.equal(callsToLogin(f.state.calls).filter(call => call.method === 'POST').length, 1);
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        const posts = callsToLogin(f.state.calls).filter(call => call.method === 'POST');
        assert.equal(posts.length, 2);
        assert.deepEqual(posts.map(call => call.body), [
          { requestId: intent.requestId, userOptions: { equipmentStamina: false } },
          { requestId: intent.requestId, userOptions: { equipmentStamina: false } },
        ]);
      } finally { gate.resolve(); await f.close(); }
    });

    await t.test('automatic and manual retries keep the original options and request ID', async () => {
      const f = await fixture();
      try {
        f.state.submitStatus = 503;
        f.state.submit = () => ({ error: '模拟网络中断，请重试查询。' });
        await f.open();
        await equipmentStamina(f.page).uncheck();
        await generate(f.page).click();
        await f.page.getByRole('button', { name: '继续本次申请', exact: true }).waitFor();
        assert.equal(await equipmentStamina(f.page).isChecked(), false);
        assert.equal(await equipmentStamina(f.page).isDisabled(), true);
        const firstPosts = callsToLogin(f.state.calls).filter(call => call.method === 'POST');
        assert.equal(firstPosts.length, 3);
        f.state.submitStatus = 200;
        f.state.submit = request => ({ ...session('queued'), userOptions: request.postDataJSON().userOptions });
        f.state.detail = () => ({ ...session(), userOptions: { equipmentStamina: false } });
        await f.page.getByRole('button', { name: '继续本次申请', exact: true }).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        const posts = callsToLogin(f.state.calls).filter(call => call.method === 'POST');
        assert.equal(posts.length, 4);
        for (const post of posts) assert.deepEqual(post.body, {
          requestId: firstPosts[0].body.requestId, userOptions: { equipmentStamina: false },
        });
      } finally { await f.close(); }
    });

    await t.test('click with no active session creates once and polls until its QR is ready', async () => {
      const f = await fixture();
      try {
        let details = 0;
        f.state.detail = () => session(++details === 1 ? 'preparing_qr' : 'qr_ready');
        await f.open();
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        const calls = callsToLogin(f.state.calls);
        assert.deepEqual(calls.slice(0, 2).map(call => [call.method, call.path]), [
          ['GET', '/api/login-sessions/active'], ['POST', '/api/login-sessions'],
        ]);
        assert.equal(calls.filter(call => call.method === 'POST').length, 1);
        assert.equal(details, 2);
        assert.equal(calls.at(-1).path, `/api/login-sessions/${sessionId}/qr`);
      } finally { await f.close(); }
    });

    await t.test('reload with a saved pending intent stays idle; clicking reuses the same requestId', async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page.evaluate(({ userId, requestId }) => {
          const now = Date.now();
          localStorage.setItem(`naruto-login:pending:${userId}`, JSON.stringify({ requestId, createdAt: now, expiresAt: now + 120_000 }));
        }, { userId: firstUser.id, requestId: pendingId });
        await f.page.reload({ waitUntil: 'networkidle' });
        await generate(f.page).waitFor();
        assert.deepEqual(callsToLogin(f.state.calls), []);
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        const posts = callsToLogin(f.state.calls).filter(call => call.method === 'POST');
        assert.equal(posts.length, 1);
        assert.equal(posts[0].body.requestId, pendingId);
      } finally { await f.close(); }
    });

    await t.test('QR expiry checks once for a claimed occupancy lease before ending', async () => {
      const f = await fixture();
      try {
        const expiring = session('qr_ready', Date.now() + 1_800);
        f.state.active = () => ({ session: expiring, showGetButton: false });
        await f.open();
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        await f.page.getByText('二维码已过期', { exact: true }).first().waitFor();
        assert.ok(await f.page.getByText('二维码已过期', { exact: true }).count());
        assert.equal(await f.page.locator('img[src^="blob:"]').count(), 0);
        assert.equal(callsToLogin(f.state.calls).filter(call => call.path.endsWith('/active')).length, 2);
        f.state.active = () => ({ session: session('qr_ready', Date.now() + 60_000), showGetButton: false });
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(callsToLogin(f.state.calls).filter(call => call.path.endsWith('/active')).length, 3);
      } finally { await f.close(); }
    });

    await t.test('switching account cancels the old active query and does not fetch the previous account QR', async () => {
      const f = await fixture();
      const gate = deferred();
      try {
        f.state.active = async () => { await gate.promise; return { session: session(), showGetButton: false }; };
        await f.open();
        await equipmentStamina(f.page).uncheck();
        await generate(f.page).click();
        await waitFor(() => callsToLogin(f.state.calls).length === 1, 'First account should issue active query');
        f.state.user = secondUser;
        await f.page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {
          key: 'naruto-login:auth-changed', newValue: `${Date.now()}:test-switch`,
        })));
        await f.page.getByText(secondUser.username, { exact: true }).waitFor();
        await generate(f.page).waitFor();
        gate.resolve();
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await f.page.locator('img[src^="blob:"]').count(), 0);
        assert.deepEqual(callsToLogin(f.state.calls).map(call => call.path), ['/api/login-sessions/active']);
        assert.equal(await generate(f.page).isEnabled(), true);
        assert.equal(await equipmentStamina(f.page).isChecked(), true);
        assert.equal(await equipmentStamina(f.page).isEnabled(), true);
      } finally { gate.resolve(); await f.close(); }
    });

    await t.test('fixed stages follow QR preparation and script execution, survive QR expiry and lazy reload, then complete', async () => {
      const f = await fixture();
      try {
        let created;
        let qrStatus = 'queued';
        let runStatus = 'starting_emulator';
        let startedAt = null;
        const logs = [];
        const milestone = message => logs.push({ id: `${logs.length + 1}-0`, time: new Date().toISOString(), level: 'INFO', message });
        f.state.latest = () => ({ task: created ? { ...created, status: qrStatus } : null });
        f.state.submit = request => {
          created = { ...session('queued'), userOptions: request.postDataJSON().userOptions };
          milestone('登录申请已提交，等待执行。');
          return created;
        };
        f.state.detail = () => ({ ...created, status: qrStatus });
        f.state.events = (taskId, url) => {
          const after = Number((url.searchParams.get('after') || '0-0').split('-')[0]);
          const now = new Date().toISOString();
          return { task: { ...created, id: taskId, status: qrStatus },
            run: { taskId, status: runStatus, updatedAt: now, startedAt,
              finishedAt: runStatus === 'completed' ? now : null, ...(startedAt ? { actionIndex: 2, actionTotal: 38 } : {}) },
            logs: logs.filter(log => Number(log.id.split('-')[0]) > after),
            nextCursor: `${logs.length}-0`, hasMore: false, truncated: false };
        };
        await f.open();
        await expectStages(f.page, ['pending', 'pending', 'pending']);
        await equipmentStamina(f.page).uncheck();
        await generate(f.page).click();
        await expectStages(f.page, ['completed', 'active', 'pending']);
        qrStatus = 'preparing_qr';
        runStatus = 'preparing_qr';
        milestone('游戏已打开，正在获取二维码。');
        await expandRecords(f.page).click();
        await f.page.getByRole('log', { name: '任务执行日志' }).getByText(logs.at(-1).message, { exact: true }).waitFor();
        await expectStages(f.page, ['completed', 'active', 'pending']);
        qrStatus = 'qr_ready';
        runStatus = 'waiting_scan';
        milestone('二维码已就绪，等待扫码登录。');
        await f.page.locator('img[src^="blob:"]').waitFor();
        await expectStages(f.page, ['completed', 'completed', 'pending']);
        runStatus = 'running_daily';
        startedAt = new Date().toISOString();
        milestone('登录完成，开始执行日常脚本。');
        await expectStages(f.page, ['completed', 'completed', 'active']);
        assert.equal(await equipmentStamina(f.page).isChecked(), false);
        assert.equal(await equipmentStamina(f.page).isDisabled(), true);
        const progressCard = f.page.locator('[data-slot="card"]').filter({ has: f.page.getByLabel('任务执行进度', { exact: true }) });
        await progressCard.getByText('脚本执行中', { exact: true }).waitFor();
        const screenshotPath = path.join(repository, '.data/login-lazy-integration/running-daily.png');
        await mkdir(path.dirname(screenshotPath), { recursive: true });
        await f.page.screenshot({ path: screenshotPath, fullPage: true });
        t.diagnostic(`Running script screenshot: ${screenshotPath}`);
        const loginCalls = callsToLogin(f.state.calls).length;
        // Move only this isolated page's clock beyond the QR TTL; no fixed wait for the full TTL.
        await f.page.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 120_000; });
        await f.page.waitForTimeout(1_100);
        assert.equal(await generate(f.page).isEnabled(), false, 'Confirmed execution keeps QR generation unavailable');
        await expectStages(f.page, ['completed', 'completed', 'active']);
        assert.equal(await progressCard.getByText('脚本执行中', { exact: true }).isVisible(), true);
        assert.equal(await progressCard.getByText('获取失败', { exact: true }).count(), 0);
        assert.equal(callsToLogin(f.state.calls).length, loginCalls);
        qrStatus = 'expired';
        created.expiresAt = new Date(Date.now() - 1_000).toISOString();
        await f.page.reload({ waitUntil: 'networkidle' });
        await expectStages(f.page, ['completed', 'completed', 'active']);
        assert.equal(await equipmentStamina(f.page).isChecked(), false, 'Restore the running task options after the pending intent has been cleared');
        assert.equal(await equipmentStamina(f.page).isDisabled(), true, 'A restored running task cannot change its queued options');
        assert.equal(await f.page.locator('img[src^="blob:"]').count(), 0);
        assert.equal(callsToLogin(f.state.calls).length, loginCalls, 'Restoring script progress must not load the QR');
        runStatus = 'completed';
        milestone('日常脚本执行完成。');
        await expectStages(f.page, ['completed', 'completed', 'completed']);
        assert.equal(await equipmentStamina(f.page).isEnabled(), true, 'Completed tasks allow configuring the next request');
        await equipmentStamina(f.page).uncheck();
        assert.equal(await equipmentStamina(f.page).isChecked(), false);
        await equipmentStamina(f.page).check();
        assert.equal(await equipmentStamina(f.page).isChecked(), true);
        await progressCard.getByText('任务已完成', { exact: true }).waitFor();
        assert.equal(await expandRecords(f.page).getAttribute('aria-expanded'), 'false', 'Reload restores records in the collapsed state');
        await expandRecords(f.page).click();
        const logArea = f.page.getByRole('log', { name: '任务执行日志' });
        for (const entry of logs) assert.equal(await logArea.getByText(entry.message, { exact: true }).isVisible(), true);
        assert.equal(callsToLogin(f.state.calls).length, loginCalls);
      } finally { await f.close(); }
    });

    await t.test('restoring a failed script leaves submission and QR completed and marks only execution failed', async () => {
      const f = await fixture();
      try {
        const failedTask = { ...session('expired', Date.now() - 60_000), id: latestId };
        f.state.latest = () => ({ task: failedTask });
        f.state.events = taskId => {
          const time = new Date().toISOString();
          return { task: failedTask,
            run: { taskId, status: 'failed', updatedAt: time, startedAt: time, finishedAt: time, errorCode: 'daily_failed' },
            logs: [{ id: '1-0', time, level: 'ERROR', message: '日常脚本执行失败，请检查执行环境后重试。' }],
            nextCursor: '1-0', hasMore: false, truncated: false };
        };
        await f.open();
        await expectStages(f.page, ['completed', 'completed', 'failed']);
        await f.page.getByRole('alert', { name: '任务失败原因' }).waitFor();
        assert.equal(await expandRecords(f.page).getAttribute('aria-expanded'), 'false');
        assert.equal(await f.page.getByRole('log', { name: '任务执行日志' }).count(), 0, 'Detailed logs stay out of the initial view');
        await expandRecords(f.page).click();
        await f.page.getByRole('log', { name: '任务执行日志' }).getByText('错误', { exact: true }).waitFor();
        await f.page.getByRole('button', { name: '收起记录', exact: true }).click();
        assert.equal(await f.page.getByRole('log', { name: '任务执行日志' }).count(), 0);
        assert.equal(await f.page.getByRole('alert', { name: '任务失败原因' }).isVisible(), true, 'Collapsing logs preserves the failure summary');
        await expandRecords(f.page).click();
        await f.page.getByRole('log', { name: '任务执行日志' }).getByText('日常脚本执行失败，请检查执行环境后重试。', { exact: true }).waitFor();
        assert.deepEqual(callsToLogin(f.state.calls), []);
      } finally { await f.close(); }
    });

    await t.test('an accepted session keeps its execution records visible when reading the QR image fails', async () => {
      const f = await fixture();
      try {
        f.state.latest = () => ({ task: null });
        f.state.active = () => ({ session: session(), showGetButton: false });
        f.state.qrResponse = { status: 400, json: { error: '本次二维码图片暂时无法读取，请重试查询。' } };
        const message = '已接受申请的执行记录仍可查看。';
        f.state.events = (taskId, url) => {
          const time = new Date().toISOString();
          return { task: { ...session(), id: taskId },
            run: { taskId, status: 'running_daily', updatedAt: time, startedAt: time, finishedAt: null },
            logs: url.searchParams.get('after') === '0-0' ? [{ id: '1-0', time, level: 'INFO', message }] : [],
            nextCursor: '1-0', hasMore: false, truncated: false };
        };
        await f.open();
        await generate(f.page).click();
        await expectStages(f.page, ['completed', 'completed', 'active']);
        await expandRecords(f.page).click();
        await f.page.getByRole('log', { name: '任务执行日志' }).getByText(message, { exact: true }).waitFor();
        assert.equal(callsToLogin(f.state.calls).filter(call => call.method === 'POST').length, 0);
      } finally { await f.close(); }
    });

    await t.test('worker clock failure is visible in QR and ERROR logs, survives expiry, and restores logs after reload', async () => {
      const f = await fixture();
      try {
        let created;
        let failed = false;
        f.state.latest = () => ({ task: failed ? { ...created, status: 'failed' } : null });
        f.state.submit = () => {
          created = session('queued', Date.now() + 2_500);
          return created;
        };
        f.state.detail = () => {
          failed = true;
          return { ...created, status: 'failed', showGetButton: true, errorCode: 'worker_clock_skew', error: clockError };
        };
        f.state.events = (taskId, url) => {
          const time = new Date().toISOString();
          const after = url.searchParams.get('after') || '0-0';
          const logs = failed && after === '0-0'
            ? [{ id: '1-0', time, level: 'ERROR', message: clockError }] : [];
          return { task: { ...created, id: taskId, status: failed ? 'failed' : 'queued' },
            run: { taskId, status: failed ? 'failed' : 'starting_emulator', updatedAt: time,
              startedAt: null, finishedAt: failed ? time : null, ...(failed ? { errorCode: 'worker_clock_skew' } : {}) },
            logs, nextCursor: logs.length ? '1-0' : after, hasMore: false, truncated: false };
        };
        await f.open();
        await generate(f.page).click();
        const qrCard = f.page.locator('[data-slot="card"]').filter({ has: f.page.getByRole('heading', { name: '扫码登录', exact: true }) });
        const runCard = f.page.locator('[data-slot="card"]').filter({ has: f.page.getByRole('heading', { name: '任务执行记录', exact: true }) });
        await qrCard.getByText(clockError, { exact: true }).waitFor();
        await runCard.getByRole('alert', { name: '任务失败原因' }).waitFor();
        await expandRecords(f.page).click();
        const logArea = f.page.getByRole('log', { name: '任务执行日志' });
        await logArea.getByText(clockError, { exact: true }).waitFor();
        await expectStages(f.page, ['completed', 'failed', 'pending']);
        assert.equal(await logArea.getByText('错误', { exact: true }).count(), 1);
        assert.ok(await runCard.getByText('执行失败', { exact: true }).count());
        assert.equal(callsToLogin(f.state.calls).filter(call => call.method === 'POST').length, 1);
        assert.equal(callsToLogin(f.state.calls).filter(call => call.path.endsWith('/qr')).length, 0);
        const loginCalls = callsToLogin(f.state.calls).length;
        await f.page.waitForTimeout(Math.max(0, Date.parse(created.expiresAt) - Date.now()) + 1_100);
        assert.equal(await qrCard.getByText(clockError, { exact: true }).isVisible(), true);
        assert.equal(await qrCard.getByText('二维码已过期', { exact: true }).count(), 0);
        assert.equal(callsToLogin(f.state.calls).length, loginCalls);
        await f.page.reload({ waitUntil: 'networkidle' });
        await generate(f.page).waitFor();
        await runCard.getByRole('alert', { name: '任务失败原因' }).waitFor();
        await expandRecords(f.page).click();
        await f.page.getByRole('log', { name: '任务执行日志' }).getByText(clockError, { exact: true }).waitFor();
        assert.equal(callsToLogin(f.state.calls).length, loginCalls, 'Reload must restore run logs without querying QR sessions');
        assert.ok(f.state.calls.filter(call => call.path === '/api/task-runs/latest').length >= 2);
      } finally { await f.close(); }
    });

    await t.test('failed run exposes its clock error code even when no log entries remain', async () => {
      const f = await fixture();
      try {
        const failedTask = { ...session('failed', Date.now() - 60_000), id: latestId };
        f.state.latest = () => ({ task: failedTask });
        f.state.events = taskId => {
          const time = new Date().toISOString();
          return { task: failedTask,
            run: { taskId, status: 'failed', updatedAt: time, startedAt: null, finishedAt: time, errorCode: 'worker_clock_skew' },
            logs: [], nextCursor: '0-0', hasMore: false, truncated: false };
        };
        await f.open();
        const runCard = f.page.locator('[data-slot="card"]').filter({ has: f.page.getByRole('heading', { name: '任务执行记录', exact: true }) });
        await runCard.getByRole('alert', { name: '任务失败原因' }).getByText(clockError, { exact: true }).waitFor();
        assert.equal(await f.page.getByRole('log', { name: '任务执行日志' }).count(), 0);
        assert.deepEqual(callsToLogin(f.state.calls), []);
        assert.ok(await runCard.getByText('执行失败', { exact: true }).count());
      } finally { await f.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    await rmdir(emptyEnv);
  }
});
