// Run with: node --test tests/frontend-main-task.integration.mjs
// Optional existing browser dependencies: PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE.
// Every API is mocked. Vite has an empty env directory and never starts the backend.
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

const user = { id: 'main-task-user', username: '主任务测试用户', isAdmin: false };
const sessionId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7nwAAAAASUVORK5CYII=', 'base64');
const weeklyOptions = { equipmentStamina: true, secretRealmMode: 'all', mainTask: 'arena_weekly' };
const daily = page => page.getByRole('tab', { name: '日常任务', exact: true });
const weekly = page => page.getByRole('tab', { name: '决斗场周胜', exact: true });
const isSelected = async tab => (await tab.getAttribute('aria-selected')) === 'true';
const weeklyRegion = page => page.getByRole('region', { name: '决斗场周胜任务', exact: true });
const generate = page => page.getByRole('button', { name: '启动模拟器获取二维码', exact: true });
const equipment = page => page.locator('input[aria-labelledby="equipment-stamina-label"]');
const secretRealm = page => page.getByRole('button', { name: '秘境探险', exact: true });
const loginCalls = state => state.calls.filter(call => call.path.startsWith('/api/login-sessions'));
const posts = state => loginCalls(state).filter(call => call.method === 'POST');
function session(status = 'qr_ready', userOptions) {
  return { id: sessionId, status, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), simulation: true,
    showGetButton: false, pollAfterMs: 500, ...(userOptions ? { userOptions } : {}) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate, message, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function selectTask(page, task) {
  const tab = task === 'arena_weekly' ? weekly(page) : daily(page);
  await tab.click();
  assert.equal(await isSelected(tab), true);
}
async function assertNoHorizontalOverflow(page) {
  const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.document <= size.viewport + 1 && size.body <= size.viewport + 1,
    `Page must fit the viewport: ${JSON.stringify(size)}`);
}
async function assertPortraitOnlyHero(page) {
  assert.equal(await page.locator('#welcome-title, #mobile-welcome-title, .village-hero-copy').count(), 0,
    'The old hero headline, platform label and explanation have been removed');
  assert.doesNotMatch(await page.locator('body').innerText(), /上号，\s*清日常。|上场，\s*拿下周胜。/);
  const portrait = page.locator('.village-portrait:visible, .mobile-character:visible');
  assert.equal(await portrait.count(), 1, 'The current viewport must keep one visible character portrait');
  assert.equal(await portrait.isVisible(), true);
  const bounds = await portrait.boundingBox();
  assert.ok(bounds && bounds.width >= 64 && bounds.height >= 96, 'The retained portrait must have a usable visible size');
  await portrait.locator('.konan-portrait-base').evaluate(image => image.decode());
  assert.equal(await portrait.locator('.konan-portrait-base').evaluate(image => image.naturalWidth > 0), true);
}
async function assertTaskPanelLinks(page) {
  const tabs = page.getByRole('tablist', { name: '主任务', exact: true }).getByRole('tab');
  for (const tab of await tabs.all()) {
    const controlledId = await tab.getAttribute('aria-controls');
    assert.ok(controlledId, 'Every task tab references its task panel');
    assert.equal(await page.evaluate(id => !!document.getElementById(id), controlledId), true,
      'An inactive task tab must not reference a missing panel');
  }
  const selected = page.getByRole('tab', { selected: true });
  const panel = page.getByRole('tabpanel');
  assert.equal(await panel.getAttribute('id'), await selected.getAttribute('aria-controls'));
  assert.equal(await panel.getAttribute('aria-labelledby'), await selected.getAttribute('id'));
}

test('main task selection preserves task options and session ownership', { skip: unavailable || false, timeout: 180_000 }, async t => {
  const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(frontendRequire.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(frontendRequire.resolve('@tailwindcss/vite')).href);
  const emptyEnv = await mkdtemp(path.join(os.tmpdir(), 'naruto-main-task-env-'));
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

    async function fixture(options = {}, authenticated = true) {
      const context = await browser.newContext(options);
      const state = { user: authenticated ? user : null, calls: [], errors: [],
        active: () => ({ session: null, showGetButton: true }),
        submit: request => session('queued', request.postDataJSON().userOptions),
        detail: () => session('qr_ready', weeklyOptions),
        refresh: () => ({ ...session('qr_ready', weeklyOptions), qrRevision: revisionId }),
        latest: () => ({ task: null }),
        events: (taskId, url) => ({ task: { ...session('qr_ready', weeklyOptions), id: taskId },
          run: { taskId, status: 'waiting_scan', updatedAt: new Date().toISOString(), startedAt: null, finishedAt: null },
          logs: [], nextCursor: url.searchParams.get('after') || '0-0', hasMore: false, truncated: false }) };
      context.on('page', page => page.on('pageerror', error => state.errors.push(error.message)));
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        state.calls.push({ path: url.pathname, method: request.method(),
          body: request.method() === 'POST' ? request.postDataJSON() : null });
        let body;
        if (url.pathname === '/api/health') body = { ok: true, environment: 'test' };
        else if (url.pathname === '/api/auth/me') body = { user: state.user };
        else if (url.pathname === '/api/auth/login') {
          state.user = user;
          body = { user };
        } else if (url.pathname === '/api/login-sessions/active') body = await state.active(request);
        else if (url.pathname === '/api/login-sessions' && request.method() === 'POST') body = await state.submit(request);
        else if (url.pathname === `/api/login-sessions/${sessionId}/refresh`) body = await state.refresh(request);
        else if (url.pathname === `/api/login-sessions/${sessionId}`) body = await state.detail(request);
        else if (url.pathname === `/api/login-sessions/${sessionId}/qr`) {
          return route.fulfill({ status: 200, contentType: 'image/png', body: png }).catch(() => {});
        } else if (url.pathname === '/api/task-runs/latest') body = await state.latest();
        else if (/^\/api\/task-runs\/[^/]+\/events$/.test(url.pathname)) body = await state.events(url.pathname.split('/')[3], url);
        else {
          state.errors.push(`Unexpected mocked API: ${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 404, json: {} });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      return { context, page, state,
        async open() { await page.goto(origin, { waitUntil: 'networkidle' }); await daily(page).waitFor(); },
        async close() { await context.close(); assert.deepEqual(state.errors, []); } };
    }

    await t.test('guests can preview both tasks at desktop, 390px and 320px without creating a session', async () => {
      for (const width of [1280, 390, 320]) {
        const f = await fixture({ viewport: { width, height: 844 }, hasTouch: width < 640 }, false);
        try {
          await f.open();
          const tablist = f.page.getByRole('tablist', { name: '主任务', exact: true });
          assert.equal(await tablist.getAttribute('data-slot'), 'tabs-list', 'The task choices use shadcn Tabs');
          assert.equal(await tablist.getByRole('tab').count(), 2);
          assert.equal(await daily(f.page).getAttribute('data-slot'), 'tabs-trigger');
          assert.equal(await isSelected(daily(f.page)), true, 'An absent mainTask keeps the daily default');
          assert.equal(await weekly(f.page).isEnabled(), true);
          await assertTaskPanelLinks(f.page);
          await assertPortraitOnlyHero(f.page);
          await assertNoHorizontalOverflow(f.page);

          await daily(f.page).focus();
          await f.page.keyboard.press('ArrowRight');
          assert.equal(await weekly(f.page).evaluate(tab => tab === document.activeElement), true);
          assert.equal(await isSelected(daily(f.page)), true, 'Arrow navigation changes focus without activating a task');
          await f.page.keyboard.press('Enter');
          assert.equal(await isSelected(weekly(f.page)), true, 'Enter activates the focused task');
          await f.page.keyboard.press('ArrowLeft');
          assert.equal(await daily(f.page).evaluate(tab => tab === document.activeElement), true);
          assert.equal(await isSelected(weekly(f.page)), true);
          await f.page.keyboard.press('Space');
          assert.equal(await isSelected(daily(f.page)), true, 'Space also activates the focused task');

          async function screenshotTask(task) {
            if (!process.env.MAIN_TASK_SCREENSHOT_DIR || width === 320) return;
            const screenshot = path.resolve(process.env.MAIN_TASK_SCREENSHOT_DIR, `${task}-${width}.png`);
            await mkdir(path.dirname(screenshot), { recursive: true });
            await f.page.evaluate(async () => {
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
              await document.fonts.ready;
              await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
              await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
                .map(animation => animation.finished.catch(() => {})));
              window.scrollTo(0, 0);
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            await f.page.screenshot({ path: screenshot });
            t.diagnostic(`Task screenshot: ${screenshot}`);
          }
          await screenshotTask('daily');
          await selectTask(f.page, 'arena_weekly');
          await weeklyRegion(f.page).waitFor();
          await assertTaskPanelLinks(f.page);
          assert.equal(await equipment(f.page).isVisible(), false);
          assert.equal(await secretRealm(f.page).isVisible(), false);
          await assertPortraitOnlyHero(f.page);
          await assertNoHorizontalOverflow(f.page);
          await screenshotTask('arena-weekly');
          await selectTask(f.page, 'daily');
          assert.equal(await weeklyRegion(f.page).isVisible(), false);
          await assertNoHorizontalOverflow(f.page);
          assert.deepEqual(loginCalls(f.state), [], 'Task previews must not read, submit or refresh QR sessions');
        } finally { await f.close(); }
      }
    });

    await t.test('authenticated switching preserves daily selections and does not request a QR', async () => {
      const f = await fixture();
      try {
        await f.open();
        await equipment(f.page).uncheck();
        await secretRealm(f.page).click();
        await f.page.getByRole('menuitemradio', { name: '只刷一次就退出', exact: true }).click();
        await selectTask(f.page, 'arena_weekly');
        await weeklyRegion(f.page).waitFor();
        assert.equal(await equipment(f.page).isVisible(), false);
        assert.equal(await secretRealm(f.page).isVisible(), false);
        await selectTask(f.page, 'daily');
        assert.equal(await equipment(f.page).isChecked(), false);
        assert.equal(await secretRealm(f.page).getByText('只刷一次就退出', { exact: true }).count(), 1);
        assert.deepEqual(loginCalls(f.state), []);
      } finally { await f.close(); }
    });

    await t.test('logging in preserves the guest weekly choice and submits it only after the task button', async () => {
      const f = await fixture({}, false);
      try {
        await f.open();
        await selectTask(f.page, 'arena_weekly');
        await f.page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
        const dialog = f.page.getByRole('dialog');
        await dialog.getByRole('textbox', { name: '用户名', exact: true }).fill('task_test');
        await dialog.getByLabel('密码', { exact: true }).fill('task_password');
        await dialog.getByRole('button', { name: '登录', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await f.page.getByTitle(user.username, { exact: true }).waitFor();
        assert.equal(await isSelected(weekly(f.page)), true);
        assert.deepEqual(loginCalls(f.state), [], 'Account login must not implicitly submit the chosen task');
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(posts(f.state).length, 1);
        assert.equal(posts(f.state)[0].body.userOptions.mainTask, 'arena_weekly');
        assert.equal(await isSelected(weekly(f.page)), true);
      } finally { await f.close(); }
    });

    await t.test('weekly choice locks during submission and scanning, then survives lazy recovery and QR refresh', async () => {
      const f = await fixture();
      const gate = deferred();
      try {
        f.state.active = async () => { await gate.promise; return { session: null, showGetButton: true }; };
        await f.open();
        await selectTask(f.page, 'arena_weekly');
        await generate(f.page).click();
        await waitFor(() => loginCalls(f.state).length === 1, 'Submission should first check the active session');
        assert.equal(await daily(f.page).isDisabled(), true);
        assert.equal(await weekly(f.page).isDisabled(), true);
        gate.resolve();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.deepEqual(posts(f.state)[0].body.userOptions, weeklyOptions);
        assert.equal(await daily(f.page).isDisabled(), true);
        assert.equal(await weekly(f.page).isDisabled(), true);
        f.state.active = () => ({ session: session('qr_ready', weeklyOptions), showGetButton: false });
        const beforeReload = loginCalls(f.state).length;
        await f.page.reload({ waitUntil: 'networkidle' });
        await generate(f.page).waitFor();
        assert.equal(loginCalls(f.state).length, beforeReload, 'Reload remains lazy and does not read the QR session');
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(await isSelected(weekly(f.page)), true);
        assert.equal(await daily(f.page).isDisabled(), true);
        await f.page.getByRole('button', { name: '刷新二维码', exact: true }).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(posts(f.state).length, 2, 'Recovery reuses the existing session');
        assert.equal(posts(f.state)[1].path, `/api/login-sessions/${sessionId}/refresh`);
        assert.deepEqual(posts(f.state)[1].body, {}, 'Refresh reuses saved server options');
        assert.equal(await isSelected(weekly(f.page)), true);
        assert.equal(await weekly(f.page).isDisabled(), true);
        await weeklyRegion(f.page).waitFor();
      } finally { gate.resolve(); await f.close(); }
    });

    await t.test('reload restores weekly execution without reading QR; completion enables the next task', async () => {
      const f = await fixture();
      try {
        const task = { ...session('expired', weeklyOptions), expiresAt: new Date(Date.now() - 60_000).toISOString() };
        let status = 'running_daily'; // Existing worker status remains compatible with the selected main task.
        f.state.latest = () => ({ task });
        f.state.events = (taskId, url) => {
          const now = new Date().toISOString();
          return { task, run: { taskId, status, updatedAt: now, startedAt: now,
            finishedAt: status === 'completed' ? now : null }, logs: [],
            nextCursor: url.searchParams.get('after') || '0-0', hasMore: false, truncated: false };
        };
        await f.open();
        await waitFor(() => isSelected(weekly(f.page)), 'Running weekly selection should be recovered');
        assert.equal(await daily(f.page).isDisabled(), true);
        assert.equal(await weekly(f.page).isDisabled(), true);
        await weeklyRegion(f.page).waitFor();
        assert.deepEqual(loginCalls(f.state), []);
        await f.page.reload({ waitUntil: 'networkidle' });
        await waitFor(() => isSelected(weekly(f.page)), 'Reload should keep the running task selection');
        assert.equal(await weekly(f.page).isDisabled(), true);
        assert.deepEqual(loginCalls(f.state), []);
        status = 'completed';
        await waitFor(() => daily(f.page).isEnabled(), 'Completed execution should allow configuring the next task');
        await selectTask(f.page, 'daily');
        assert.equal(await equipment(f.page).isVisible(), true);
        assert.equal(await weeklyRegion(f.page).isVisible(), false);
        assert.deepEqual(loginCalls(f.state), [], 'Changing the next task never starts it implicitly');
      } finally { await f.close(); }
    });

    await t.test('reload preserves an unconfirmed weekly intent and reuses its saved request ID', async () => {
      const f = await fixture();
      const gate = deferred();
      try {
        let submissions = 0;
        f.state.submit = async request => {
          if (++submissions === 1) await gate.promise;
          return session('queued', request.postDataJSON().userOptions);
        };
        await f.open();
        await selectTask(f.page, 'arena_weekly');
        await generate(f.page).click();
        await waitFor(() => posts(f.state).length === 1, 'The first submitted request should remain unconfirmed');
        const intent = await f.page.evaluate(userId => JSON.parse(localStorage.getItem(`naruto-login:pending:${userId}`)), user.id);
        assert.equal(intent.userOptions.mainTask, 'arena_weekly');
        const beforeReload = loginCalls(f.state).length;
        await f.page.reload({ waitUntil: 'networkidle' });
        await generate(f.page).waitFor();
        assert.equal(await isSelected(weekly(f.page)), true);
        assert.equal(await weekly(f.page).isDisabled(), true, 'An unconfirmed saved intent cannot change task type');
        assert.equal(loginCalls(f.state).length, beforeReload, 'Reload waits for an explicit recovery click');
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(posts(f.state).length, 2);
        for (const post of posts(f.state)) {
          assert.equal(post.body.requestId, intent.requestId);
          assert.equal(post.body.userOptions.mainTask, 'arena_weekly');
        }
      } finally { gate.resolve(); await f.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    await rmdir(emptyEnv);
  }
});
