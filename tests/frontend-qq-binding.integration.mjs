// Real App browser tests. Vite uses an empty env directory; every API is intercepted.
// Run with existing PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_EXECUTABLE when needed.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repository, 'src/frontend');
const require = createRequire(path.join(root, 'package.json'));
let chromium, skip = '';
try {
  const entry = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright');
  ({ chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(path.resolve(entry)).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error();
} catch { skip = 'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing browser dependencies.'; }

const now = Date.parse('2026-10-26T08:00:00.000Z');
const boundAt = '2026-10-25T08:00:00.000Z';
const challengeId = '70000000-0000-4000-8000-000000000001';
const replacementChallengeId = '70000000-0000-4000-8000-000000000002';
const user = { id: 'qq-user-one', username: '第一位用户', isAdmin: false };
const secondUser = { id: 'qq-user-two', username: '第二位用户', isAdmin: false };
const unbound = () => ({ enabled: true, binding: null, challenge: null });
const challenge = (lifetime = 300_000) => ({
  id: challengeId, expiresAt: new Date(now + lifetime).toISOString(),
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('QQ group binding lifecycle in the real account page', { skip: skip || false, timeout: 120_000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-qq-binding-empty-env-'));
  const server = await createServer({ configFile: false, root, envDir, plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 0,
      fs: { allow: [repository, realpathSync(path.join(root, 'node_modules'))] } }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture(width = 1280) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      await page.clock.install({ time: new Date(now) });
      const state = { user, status: unbound(), calls: [], errors: [], read: null, generate: null };
      page.on('pageerror', error => state.errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const method = route.request().method();
        const reply = (json, status = 200) => route.fulfill({ status, json }).catch(() => {});
        if (url.pathname === '/api/auth/me') return reply({ user: state.user });
        if (url.pathname === '/api/auth/logout') { state.user = null; return reply({ ok: true }); }
        if (url.pathname === '/api/health') return reply({ ok: true, environment: 'test' });
        if (url.pathname === '/api/task-runs/latest') return reply({ task: null, run: null });
        if (url.pathname.startsWith('/api/qq-number-binding')) {
          state.calls.push({ method, path: url.pathname, user: state.user?.id,
            body: route.request().postData() ? route.request().postDataJSON() : null });
          if (method === 'GET') {
            const result = state.read ? await state.read() : { json: structuredClone(state.status) };
            return reply(result.json, result.status);
          }
          if (url.pathname.endsWith('/challenge')) {
            if (state.generate) {
              const result = await state.generate();
              return reply(result.json, result.status);
            }
            state.status.challenge = challenge();
            return reply({ id: challengeId, code: 'AbCd1234_EfGh5678-IjKl90', expiresAt: state.status.challenge.expiresAt }, 201);
          }
          if (method === 'DELETE') {
            state.status = unbound();
            return route.fulfill({ status: 204 }).catch(() => {});
          }
        }
        state.errors.push(`Unexpected API: ${method} ${url.pathname}`);
        return reply({}, 404);
      });
      return { page, context, state,
        async open() {
          await page.goto(origin, { waitUntil: 'networkidle' });
          await page.getByRole('button', { name: 'QQ 机器人绑定', exact: true }).click();
          await page.getByRole('dialog', { name: 'QQ 机器人绑定', exact: true }).waitFor();
        },
        async close() { await context.close(); assert.deepEqual(state.errors, []); },
      };
    }

    await t.test('unconfigured bot gives a clear inactive state without issuing mutations or polling', async () => {
      const f = await fixture();
      try {
        f.state.status = { enabled: false, binding: null, challenge: null };
        await f.page.goto(origin, { waitUntil: 'networkidle' });
        assert.deepEqual(f.state.calls, [], 'binding is loaded only when its dialog opens');
        await f.page.getByRole('button', { name: 'QQ 机器人绑定', exact: true }).click();
        await f.page.getByText('暂未开启 QQ 机器人绑定', { exact: true }).waitFor();
        assert.equal(await f.page.getByRole('button', { name: /生成绑定码/ }).count(), 0);
        await f.page.clock.fastForward(30_000);
        assert.equal(f.state.calls.length, 1);
      } finally { await f.close(); }
    });

    await t.test('replacement keeps old QQ until automatic redemption, copies command and unbinds', async () => {
      const f = await fixture(390);
      try {
        f.state.status.binding = { qq: '123456789', boundAt };
        await f.open();
        await f.page.getByText('已绑定 QQ：123456789', { exact: true }).waitFor();
        await f.page.getByRole('button', { name: '重新绑定', exact: true }).click();
        await f.page.locator('code').waitFor();
        await f.page.getByText('新绑定成功前，原绑定继续生效。', { exact: true }).waitFor();
        assert.equal(await f.page.getByRole('button', { name: '确认绑定', exact: true }).count(), 0);
        await f.page.getByText('当前机器人（QQ：3470367045）', { exact: true }).waitFor();
        await f.page.getByRole('button', { name: '复制命令', exact: true }).click();
        assert.equal(await f.page.evaluate(() => navigator.clipboard.readText()), '绑定 AbCd1234_EfGh5678-IjKl90');
        await f.page.getByText('在 QQ 群输入 @，从列表中选择当前机器人（QQ：3470367045）。', { exact: true }).waitFor();
        if (process.env.QQ_BINDING_SCREENSHOT_DIR) {
          await mkdir(process.env.QQ_BINDING_SCREENSHOT_DIR, { recursive: true });
          await f.page.screenshot({ animations: 'disabled', path: path.join(process.env.QQ_BINDING_SCREENSHOT_DIR, 'qq-binding-mobile-390.png') });
        }
        f.state.status = { enabled: true, binding: { qq: '987654321', boundAt: new Date(now).toISOString() }, challenge: null };
        await f.page.clock.fastForward(3_000);
        await f.page.getByText('绑定成功', { exact: true }).waitFor();
        await f.page.getByText('已绑定 QQ：987654321', { exact: true }).waitFor();
        assert.equal(await f.page.locator('code').count(), 0);
        await f.page.getByRole('button', { name: '解除绑定', exact: true }).click();
        await f.page.getByText('尚未绑定 QQ', { exact: true }).waitFor();
        assert.deepEqual(f.state.calls.filter(call => call.method !== 'GET').map(call => [call.method, call.path]), [
          ['POST', '/api/qq-number-binding/challenge'], ['DELETE', '/api/qq-number-binding'],
        ]);
        const layout = await f.page.getByRole('dialog').evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: innerWidth }));
        assert.ok(layout.left >= 0 && layout.right <= layout.width);
      } finally { await f.close(); }
    });

    await t.test('restored challenge hides missing code and expiry stops polling', async () => {
      const f = await fixture();
      try {
        f.state.status.challenge = challenge(4_000);
        await f.open();
        await f.page.getByText(/请发送此前保存的命令/).waitFor();
        assert.equal(await f.page.getByRole('button', { name: '确认绑定', exact: true }).count(), 0);
        assert.equal(await f.page.getByRole('button', { name: '复制命令', exact: true }).count(), 0);
        await f.page.clock.fastForward(6_000);
        await f.page.getByText('绑定码已过期，请重新生成。', { exact: true }).waitFor();
        const reads = f.state.calls.length;
        await f.page.clock.fastForward(30_000);
        assert.equal(f.state.calls.length, reads);
      } finally { await f.close(); }
    });

    await t.test('redemption after the last live poll is observed once at expiry', async () => {
      const f = await fixture();
      try {
        f.state.status.challenge = challenge(4_000);
        await f.open();
        await f.page.getByText('等待机器人完成绑定', { exact: true }).waitFor();
        await f.page.clock.fastForward(2_500);
        await waitFor(() => f.state.calls.length === 2, 'last live poll started');
        await f.page.waitForTimeout(50);
        await f.page.clock.fastForward(1_000);
        f.state.status = { enabled: true, binding: { qq: '987654321', boundAt: new Date(now + 3_500).toISOString() }, challenge: null };
        await f.page.clock.fastForward(1_500);
        await f.page.getByText('绑定成功', { exact: true }).waitFor();
        await f.page.getByText('已绑定 QQ：987654321', { exact: true }).waitFor();
        assert.equal(f.state.calls.length, 3, 'one terminal status read observes the committed binding');
        await f.page.clock.fastForward(30_000);
        assert.equal(f.state.calls.length, 3, 'terminal read does not restart expired polling');
      } finally { await f.close(); }
    });

    await t.test('another page regenerating code removes the obsolete command without reporting success', async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page.getByRole('button', { name: '生成绑定码', exact: true }).click();
        await f.page.locator('code').waitFor();
        f.state.status.challenge = { ...challenge(), id: replacementChallengeId };
        await f.page.clock.fastForward(3_000);
        await f.page.getByText(/请发送此前保存的命令/).waitFor();
        assert.equal(await f.page.locator('code').count(), 0);
        assert.equal(await f.page.getByText('绑定成功', { exact: true }).count(), 0);
      } finally { await f.close(); }
    });

    await t.test('closing and switching accounts abort old requests and discard their late responses', async () => {
      const f = await fixture();
      const oldRead = deferred(), oldCode = deferred();
      try {
        f.state.read = () => oldRead.promise;
        await f.open();
        await waitFor(() => f.state.calls.length === 1, 'first binding read started');
        await f.page.keyboard.press('Escape');
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        f.state.read = null;
        await f.page.getByRole('button', { name: 'QQ 机器人绑定', exact: true }).click();
        await f.page.getByText('尚未绑定 QQ', { exact: true }).waitFor();
        oldRead.resolve({ json: { enabled: true, binding: { qq: '123456789', boundAt }, challenge: null } });
        await f.page.waitForTimeout(100);
        assert.equal(await f.page.getByText('已绑定 QQ：123456789', { exact: true }).count(), 0);
        f.state.generate = () => oldCode.promise;
        await f.page.getByRole('button', { name: '生成绑定码', exact: true }).click();
        await waitFor(() => f.state.calls.some(call => call.method === 'POST'), 'old challenge request started');
        f.state.user = secondUser;
        await f.page.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'naruto-login:auth-changed', newValue: 'another-account' })));
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        await f.page.getByRole('button', { name: 'QQ 机器人绑定', exact: true }).click();
        await f.page.getByText('尚未绑定 QQ', { exact: true }).waitFor();
        oldCode.resolve({ status: 201, json: { id: challengeId, code: 'Old12345_AbCd6789-EfGh01', expiresAt: challenge().expiresAt } });
        await f.page.waitForTimeout(100);
        assert.equal(await f.page.getByText(/Old12345_AbCd6789-EfGh01/).count(), 0);
        assert.equal(await f.page.getByRole('button', { name: '生成绑定码', exact: true }).isEnabled(), true);
        await f.page.keyboard.press('Escape');
        const calls = f.state.calls.length;
        await f.page.clock.fastForward(30_000);
        assert.equal(f.state.calls.length, calls);
      } finally { oldRead.resolve({ json: unbound() }); oldCode.resolve({ json: {} }); await f.close(); }
    });

    await t.test('requests time out, mutations stay single, and unauthorized responses return to login', async () => {
      const f = await fixture();
      const hanging = deferred();
      try {
        f.state.read = () => hanging.promise;
        await f.open();
        await waitFor(() => f.state.calls.length === 1, 'read started');
        await f.page.clock.fastForward(11_000);
        await f.page.getByRole('alert').getByText(/超时/).waitFor();
        f.state.read = null;
        await f.page.getByRole('button', { name: '重试', exact: true }).click();
        await f.page.getByText('尚未绑定 QQ', { exact: true }).waitFor();
        f.state.generate = () => hanging.promise;
        const generate = f.page.getByRole('button', { name: '生成绑定码', exact: true });
        await generate.click();
        assert.equal(await generate.isDisabled(), true);
        await f.page.evaluate(() => document.querySelectorAll('button').forEach(button => {
          if (button.textContent.includes('生成绑定码')) { button.click(); button.click(); }
        }));
        assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
        await f.page.keyboard.press('Escape');
        f.state.read = async () => ({ status: 401, json: { error: '登录已过期' } });
        await f.page.getByRole('button', { name: 'QQ 机器人绑定', exact: true }).click();
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        await f.page.getByRole('button', { name: '登录 / 注册', exact: true }).waitFor();
        assert.equal(await f.page.getByRole('button', { name: 'QQ 机器人绑定', exact: true }).count(), 0);
      } finally { hanging.resolve({ json: unbound() }); await f.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    await rmdir(envDir);
  }
});
