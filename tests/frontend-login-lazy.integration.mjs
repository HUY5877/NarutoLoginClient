// Run with: node --test tests/frontend-login-lazy.integration.mjs
// Optional external browser dependencies: PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE.
// All APIs are intercepted. Vite uses an empty env directory and never starts the backend.
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
const generate = page => page.getByRole('button', { name: /^(重新)?生成(登录)?二维码$/ });
async function waitFor(predicate, message, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
        submit: () => session('queued'), detail: () => session(), afterQr: null };
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
          return route.fulfill({ status: 200, contentType: 'image/png', body: png }).catch(() => {});
        } else if (url.pathname === '/api/task-runs/latest') {
          body = { task: { ...session('expired', Date.now() - 60_000), id: latestId } };
        } else if (/^\/api\/task-runs\/[^/]+\/events$/.test(url.pathname)) {
          const taskId = url.pathname.split('/')[3];
          const now = new Date().toISOString();
          body = { task: { ...session('expired', Date.now() - 60_000), id: taskId },
            run: { taskId, status: 'running_daily', updatedAt: now, startedAt: now, finishedAt: null, actionIndex: 2, actionTotal: 38 },
            logs: [], nextCursor: url.searchParams.get('after') || '0-0', hasMore: false, truncated: false };
        } else {
          state.errors.push(`Unexpected mocked API: ${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 404, json: {} });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
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

    await t.test('QR expiry is local; active is queried again only after the next click', async () => {
      const f = await fixture();
      try {
        f.state.active = () => ({ session: session('qr_ready', Date.now() + 1_800), showGetButton: false });
        await f.open();
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        const before = callsToLogin(f.state.calls).length;
        await f.page.getByRole('button', { name: '重新生成二维码', exact: true }).waitFor();
        assert.ok(await f.page.getByText('二维码已过期', { exact: true }).count());
        assert.equal(await f.page.locator('img[src^="blob:"]').count(), 0);
        assert.equal(callsToLogin(f.state.calls).length, before);
        await generate(f.page).click();
        await f.page.locator('img[src^="blob:"]').waitFor();
        assert.equal(callsToLogin(f.state.calls).filter(call => call.path.endsWith('/active')).length, 2);
      } finally { await f.close(); }
    });

    await t.test('switching account cancels the old active query and does not fetch the previous account QR', async () => {
      const f = await fixture();
      const gate = deferred();
      try {
        f.state.active = async () => { await gate.promise; return { session: session(), showGetButton: false }; };
        await f.open();
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
      } finally { gate.resolve(); await f.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    await rmdir(emptyEnv);
  }
});
