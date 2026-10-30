// Isolated Vite and mocked administrator APIs; no backend or credentials are loaded.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repository, 'src/frontend');
const require = createRequire(path.join(root, 'package.json'));
let chromium, unavailable = '';
try {
  const entry = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright');
  ({ chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(path.resolve(entry)).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error();
} catch { unavailable = 'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing browser dependencies.'; }

const active = ['starting_emulator', 'opening_game', 'preparing_qr', 'waiting_scan', 'finishing_login', 'running_daily'];
const inactive = ['queued', 'completed', 'failed', 'interrupted', 'expired', 'unavailable'];
const tasks = [...active, ...inactive].map((status, index) => ({
  id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  username: `测试用户_${status}`, status, mainTask: 'daily', requestedAt: '2026-10-22T00:00:00.000Z',
  scannedAt: null, completedAt: null,
}));
const admin = { id: '10000000-0000-4000-8000-000000000001', username: '管理员账号', isAdmin: true, isInvalid: false };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('管理员单条任务中断入口', { skip: unavailable || false, timeout: 120_000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-interrupt-empty-env-'));
  const server = await createServer({ configFile: false, root, envDir, plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture(viewport = { width: 1280, height: 900 }) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 768, timezoneId: 'Asia/Shanghai' });
      const page = await context.newPage();
      page.setDefaultTimeout(6_000);
      await page.clock.setFixedTime(new Date('2026-10-22T01:00:00.000Z'));
      const state = { tasks: structuredClone(tasks), reads: 0, posts: [], errors: [], result: 'success', gate: null };
      page.on('pageerror', error => state.errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const reply = (json, status = 200) => route.fulfill({ status, json });
        if (url.pathname === '/api/health') return reply({ ok: true, environment: 'test' });
        if (url.pathname === '/api/auth/me') return reply({ user: admin });
        if (url.pathname === '/api/task-runs/latest') return reply({ task: null });
        if (url.pathname === '/api/admin/daily-tasks' && route.request().method() === 'GET') {
          state.reads += 1;
          return reply({ items: state.tasks, total: state.tasks.length, page: 1, pageSize: 20,
            mainTask: 'daily', selectedDate: '2026-10-22', startDate: '2026-10-16', date: '2026-10-22', timeZone: 'Asia/Shanghai' });
        }
        const match = url.pathname.match(/^\/api\/admin\/daily-tasks\/([^/]+)\/interrupt$/);
        if (match && route.request().method() === 'POST') {
          state.posts.push({ path: url.pathname, body: route.request().postDataJSON() });
          if (state.gate) await state.gate.promise;
          if (state.result === 'forbidden') return reply({ error: '需要管理员权限。' }, 403);
          if (state.result === 'unauthorized') return reply({ error: '请重新登录。' }, 401);
          if (state.result === 'error') return reply({ error: '任务已结束，请刷新列表。' }, 409);
          if (state.result === 'wrong-task') return reply({ taskId: tasks[1].id, status: 'interrupted' });
          if (state.result === 'wrong-status') return reply({ taskId: match[1], status: 'completed' });
          state.tasks = state.tasks.map(task => task.id === match[1] ? { ...task, status: 'interrupted' } : task);
          return reply({ taskId: match[1], status: 'interrupted' });
        }
        state.errors.push(`Unexpected API ${route.request().method()} ${url.pathname}`);
        return reply({}, 404);
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^(管理员|管理员账号)$/ }).click();
      await page.getByRole('menuitem', { name: '近七天扫码情况', exact: true }).click();
      const list = page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
      await list.getByText('共 12 条 · 第 1 页 / 1 页', { exact: true }).waitFor();
      return { page, state, list, async close() { state.gate?.resolve(); await context.close(); assert.deepEqual(state.errors, []); } };
    }

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width < 768 ? '移动卡片' : '桌面表格'}只显示活跃任务入口，并确认后单条提交、刷新`, async () => {
        const f = await fixture(viewport);
        try {
          for (const task of tasks) {
            assert.equal(await f.list.getByRole('button', { name: `${task.username}的中断任务`, exact: true }).count(),
              active.includes(task.status) ? 1 : 0, task.status);
          }
          assert.equal(await f.list.getByRole('checkbox').count(), 0);
          const task = tasks[0];
          await f.list.getByRole('button', { name: `${task.username}的中断任务`, exact: true }).click();
          const confirmation = f.page.getByRole('alertdialog');
          await confirmation.getByText('中断请求提交后，执行端将在下一次状态更新时停止', { exact: false }).waitFor();
          assert.equal(f.state.posts.length, 0);
          await confirmation.getByRole('button', { name: '取消', exact: true }).click();
          assert.equal(f.state.posts.length, 0);
          await f.list.getByRole('button', { name: `${task.username}的中断任务`, exact: true }).click();
          const reads = f.state.reads;
          await confirmation.getByRole('button', { name: '确认中断', exact: true }).click();
          await confirmation.waitFor({ state: 'hidden' });
          await f.list.getByRole('button', { name: `${task.username}的中断任务`, exact: true }).waitFor({ state: 'hidden' });
          assert.deepEqual(f.state.posts, [{ path: `/api/admin/daily-tasks/${task.id}/interrupt`, body: {} }]);
          assert.ok(f.state.reads > reads);
          await f.list.getByRole('status').filter({ hasText: `已提交「${task.username}」的中断请求。` }).waitFor();
          assert.equal(await f.list.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        } finally { await f.close(); }
      });
    }

    await t.test('提交期间禁用确认与取消，重复点击不重复发送', async () => {
      const f = await fixture();
      try {
        f.state.gate = deferred();
        await f.list.getByRole('button', { name: `${tasks[0].username}的中断任务`, exact: true }).click();
        const confirmation = f.page.getByRole('alertdialog');
        const submit = confirmation.getByRole('button', { name: '确认中断', exact: true });
        await submit.click();
        await submit.waitFor({ state: 'visible' });
        assert.equal(await submit.isDisabled(), true);
        assert.equal(await confirmation.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
        await f.page.keyboard.press('Escape');
        assert.equal(await confirmation.isVisible(), true);
        await submit.dispatchEvent('click');
        assert.equal(f.state.posts.length, 1);
        f.state.gate.resolve();
        await confirmation.waitFor({ state: 'hidden' });
        assert.equal(f.state.posts.length, 1);
      } finally { await f.close(); }
    });

    for (const result of ['error', 'wrong-task', 'wrong-status']) {
      await t.test(`${result}错误留在确认框，允许修正后重试`, async () => {
        const f = await fixture();
        try {
          f.state.result = result;
          await f.list.getByRole('button', { name: `${tasks[0].username}的中断任务`, exact: true }).click();
          const confirmation = f.page.getByRole('alertdialog');
          const reads = f.state.reads;
          await confirmation.getByRole('button', { name: '确认中断', exact: true }).click();
          await confirmation.getByRole('alert').waitFor();
          assert.match(await confirmation.getByRole('alert').innerText(), /任务已结束|操作结果尚未确认/);
          assert.equal(f.state.reads, reads);
          assert.equal(await confirmation.isVisible(), true);
          f.state.result = 'success';
          await confirmation.getByRole('button', { name: '确认中断', exact: true }).click();
          await confirmation.waitFor({ state: 'hidden' });
          assert.equal(f.state.posts.length, 2);
        } finally { await f.close(); }
      });
    }

    for (const result of ['forbidden', 'unauthorized']) {
      await t.test(`${result}沿用权限丢失处理，关闭管理员列表`, async () => {
        const f = await fixture();
        try {
          f.state.result = result;
          await f.list.getByRole('button', { name: `${tasks[0].username}的中断任务`, exact: true }).click();
          await f.page.getByRole('alertdialog').getByRole('button', { name: '确认中断', exact: true }).click();
          await f.list.waitFor({ state: 'hidden' });
          assert.equal(f.state.posts.length, 1);
        } finally { await f.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); await rmdir(envDir); }
});
