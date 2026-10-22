// Browser regression checks with isolated Vite and mocked APIs; no project credentials are loaded.
// Use existing PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_EXECUTABLE if Playwright is not installed locally.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

const admin = { id: '10000000-0000-4000-8000-000000000001', username: '管理员账号', isAdmin: true, isInvalid: false,
  createdAt: '2026-10-08T00:00:00.000Z', applicationStatus: null };
const user = { ...admin, id: '10000000-0000-4000-8000-000000000002', username: 'Naruto_01', isAdmin: false };
const task = { id: '20000000-0000-4000-8000-000000000001', username: user.username, mainTask: 'daily',
  requestedAt: '2026-10-08T00:00:00.000Z', scannedAt: '2026-10-08T00:02:00.000Z', completedAt: '2026-10-08T00:30:00.000Z', status: 'completed' };

test('administrator menu, scan history and user CRUD', { skip: skip || false, timeout: 120_000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-admin-empty-env-'));
  const server = await createServer({ configFile: false, root, envDir, plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    async function fixture(isAdmin = true, viewport = { width: 1280, height: 900 }, touch = false) {
      const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, timezoneId: 'UTC' });
      const page = await context.newPage(); page.setDefaultTimeout(8_000);
      // Only this isolated page's clock changes: Beijing is already October 8 while UTC is October 7.
      await page.clock.setFixedTime(new Date('2026-10-07T16:30:00.000Z'));
      const state = { users: [structuredClone(admin), structuredClone(user)], mutations: [], adminReads: [], errors: [], access: isAdmin, failDaily: false, extraDaily: [],
        failureDetails: { errorCode: 'daily_failed', errorMessage: '日常任务执行失败，请查看执行日志。' }, detailStatus: 200, detailIdentityOverride: null, moreGate: null,
        detailResponse: { taskId: 'failed', errorCode: 'daily_failed', errorMessage: '具体错误：VisualError: 未能识别装备材料页面；执行阶段 daily 失败',
          actionIndex: 18, actionTotal: 35, actionName: '装备进阶', truncated: false,
          logs: [
            { id: '1000-0', time: '2026-10-08T00:20:00.000Z', level: 'INFO', message: '动作 18/35：装备进阶', actionIndex: 18, actionTotal: 35 },
            { id: '1001-0', time: '2026-10-08T00:20:10.000Z', level: 'WARNING', message: '装备材料识别重试 3 次仍未确认' },
            { id: '1002-0', time: '2026-10-08T00:20:11.000Z', level: 'ERROR', message: '具体错误：VisualError: 未能识别装备材料页面；执行阶段 daily 失败' },
          ] } };
      page.on('pageerror', error => state.errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const method = route.request().method();
        const reply = (json, status = 200) => route.fulfill({ status, json });
        if (url.pathname === '/api/health') return reply({ ok: true, environment: 'test' });
        if (url.pathname === '/api/auth/me') return reply({ user: { ...admin, isAdmin: state.access } });
        if (url.pathname === '/api/task-runs/latest') return reply({ task: null });
        if (url.pathname.startsWith('/api/admin/')) {
          if (!state.access) return reply({ error: '需要管理员权限。' }, 403);
          if (method === 'GET') state.adminReads.push(url.pathname + url.search);
          else state.mutations.push({ path: url.pathname, method, body: route.request().postDataJSON() });
          if (url.pathname.endsWith('/logs')) {
            if (url.searchParams.get('after') !== '0-0' && state.moreGate) await state.moreGate;
            if (state.detailStatus !== 200) return reply({ error: '任务日志暂时不可用，请稍后重试。' }, state.detailStatus);
            const compare = (left, right) => {
              const [lm, ls] = left.split('-').map(BigInt), [rm, rs] = right.split('-').map(BigInt);
              return lm < rm ? -1 : lm > rm ? 1 : ls < rs ? -1 : ls > rs ? 1 : 0;
            };
            const taskId = url.pathname.split('/')[4];
            const after = url.searchParams.get('after') || '0-0';
            const snapshotCursor = url.searchParams.get('snapshot') || state.detailResponse.logs.at(-1)?.id || '0-0';
            const remaining = state.detailResponse.logs.filter(log => compare(log.id, after) > 0 && compare(log.id, snapshotCursor) <= 0);
            const logs = remaining.slice(0, 100), hasMore = remaining.length > 100;
            const current = taskId === task.id ? task : taskId === 'running' ? { status: 'running_daily' }
              : taskId === 'failed' ? { status: 'failed' } : state.extraDaily.find(item => item.id === taskId);
            return reply({ taskId: state.detailIdentityOverride || taskId, status: state.detailResponse.status ?? current?.status ?? null, logs,
              nextCursor: hasMore ? logs.at(-1).id : snapshotCursor, snapshotCursor, hasMore, truncated: state.detailResponse.truncated });
          }
          if (url.pathname === '/api/admin/monthly-stats') {
            const month = url.searchParams.get('month'), sort = url.searchParams.get('sort');
            const items = [{ userId: 'naruto', username: 'Naruto_01', requestCount: 30, requestDays: 3 },
              { userId: 'sasuke', username: 'Sasuke_02', requestCount: 12, requestDays: 7 }];
            if (sort === 'days') items.reverse();
            return reply({ items: month === '2020-01' ? [] : items.map((item, index) => ({ ...item, rank: index + 1 })),
              total: month === '2020-01' ? 0 : 2, totalRequests: month === '2020-01' ? 0 : 42,
              month, sort, page: 1, pageSize: 20, timeZone: 'Asia/Shanghai' });
          }
          if (url.pathname === '/api/admin/daily-tasks') {
            if (state.failDaily) return reply({ error: '任务日志暂时不可用，请稍后重试。' }, 503);
            const selectedDate = url.searchParams.get('date'), page = Number(url.searchParams.get('page') || 1);
            const mainTask = url.searchParams.get('mainTask') || 'daily';
            const items = [task, { ...task, id: 'running', username: 'Sasuke_02', scannedAt: null, completedAt: null, status: 'running_daily' },
              { ...task, id: 'failed', username: 'Sakura_03', completedAt: null, status: 'failed', ...state.failureDetails }, ...state.extraDaily]
              .filter(item => item.mainTask === mainTask)
              .filter(item => !selectedDate || new Date(Date.parse(item.requestedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === selectedDate);
            return reply({ items: items.slice((page - 1) * 20, page * 20), total: items.length, page, pageSize: 20, mainTask,
              ...(selectedDate ? { selectedDate } : {}), startDate: '2026-10-02', date: '2026-10-08', timeZone: 'Asia/Shanghai' });
          }
          if (url.pathname === '/api/admin/users' && method === 'GET') {
            const filtered = state.users.filter(value => value.username.toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase()));
            const page = Number(url.searchParams.get('page') || 1);
            return reply({ items: filtered.slice((page - 1) * 20, page * 20), total: filtered.length, page, pageSize: 20 });
          }
          if (url.pathname === '/api/admin/users' && method === 'POST') {
            const input = route.request().postDataJSON();
            if (state.users.some(value => value.username.toLowerCase() === input.username.trim().toLowerCase())) return reply({ error: '该用户名已被注册。' }, 409);
            const created = { ...user, ...input, id: '10000000-0000-4000-8000-000000000003', username: input.username.trim(), applicationStatus: null };
            delete created.password; state.users.push(created); return reply({ user: created }, 201);
          }
          const target = state.users.find(value => url.pathname === `/api/admin/users/${value.id}`);
          if (target && method === 'GET') return reply({ user: target });
          if (target && method === 'PATCH') {
            const input = route.request().postDataJSON();
            Object.assign(target, { username: input.username.trim(), isAdmin: input.isAdmin, isInvalid: input.isInvalid });
            return reply({ user: target });
          }
          if (target && method === 'DELETE') { state.users = state.users.filter(value => value !== target); return route.fulfill({ status: 204 }); }
        }
        state.errors.push(`Unexpected API ${method} ${url.pathname}`); return reply({}, 404);
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.locator('span:visible').filter({ hasText: /^管理员账号$/ }).first().waitFor();
      return { context, page, state, async open(name) { await page.getByRole('button', { name: /^(管理员|管理员账号)$/ }).click(); await page.getByRole('menuitem', { name }).click(); },
        async close() { await context.close(); assert.deepEqual(state.errors, []); } };
    }

    await t.test('scan history filters task type with date, pagination, logs and reopening on desktop and mobile', async () => {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const f = await fixture(true, viewport, viewport.width < 768);
        try {
          f.state.extraDaily.push(...Array.from({ length: 21 }, (_, index) => ({ ...task, id: `weekly-${index}`,
            username: `Weekly_${index}`, mainTask: 'arena_weekly', status: index === 0 ? 'running_daily' : index === 1 ? 'failed' : 'completed',
            completedAt: index < 2 ? null : task.completedAt,
            ...(index === 1 ? { errorCode: 'daily_failed', errorMessage: '日常任务执行失败，请查看执行日志。' } : {}) })),
            { ...task, id: 'weekly-yesterday', username: 'Weekly_Yesterday', mainTask: 'arena_weekly', requestedAt: '2026-10-07T00:00:00Z' });
          await f.open('近七天扫码情况');
          const dialog = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
          const taskPicker = dialog.getByRole('combobox', { name: '任务类型', exact: true });
          const datePicker = dialog.getByRole('combobox', { name: '查看日期', exact: true });
          await dialog.getByText('共 3 条 · 第 1 页 / 1 页', { exact: true }).waitFor();
          assert.equal(await taskPicker.innerText(), '刷日常');
          assert.deepEqual(f.state.adminReads, ['/api/admin/daily-tasks?page=1&date=2026-10-08&mainTask=daily']);
          assert.doesNotMatch(await dialog.innerText(), /Weekly_/);
          await taskPicker.click();
          assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['刷日常', '刷周胜']);
          await f.page.getByRole('option', { name: '刷周胜', exact: true }).click();
          await dialog.getByText('共 21 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1&date=2026-10-08&mainTask=arena_weekly');
          assert.match(await dialog.innerText(), /Weekly_0/);
          assert.doesNotMatch(await dialog.innerText(), /Naruto_01|Sasuke_02|Sakura_03|Weekly_Yesterday/);
          await dialog.getByText('刷周胜中', { exact: true }).waitFor();
          const bounds = await dialog.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
          assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
          await mkdir(path.join(repository, '.data/admin-preview'), { recursive: true });
          await f.page.screenshot({ animations: 'disabled', path: path.join(repository,
            `.data/admin-preview/scan-weekly-${viewport.width < 768 ? 'mobile' : 'desktop'}.png`) });
          await dialog.getByRole('button', { name: 'Weekly_0的日志详情', exact: true }).click();
          const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
          await details.getByText('已加载 3 条', { exact: true }).waitFor();
          await details.getByText('刷周胜中', { exact: true }).waitFor();
          assert.equal(await details.getByText('刷日常中', { exact: true }).count(), 0);
          await details.getByRole('button', { name: '关闭日志详情', exact: true }).click();
          await details.waitFor({ state: 'hidden' });
          await dialog.getByRole('button', { name: 'Weekly_1的日志详情', exact: true }).click();
          await details.getByText('已加载 3 条', { exact: true }).waitFor();
          await details.getByText('失败', { exact: true }).waitFor();
          await details.getByText('决斗场周胜任务执行失败，请查看执行日志。', { exact: true }).waitFor();
          assert.equal(await details.getByText('日常任务执行失败，请查看执行日志。', { exact: true }).count(), 0);
          await details.getByText('错误码：daily_failed', { exact: true }).waitFor();
          await details.getByRole('button', { name: '关闭日志详情', exact: true }).click();
          await details.waitFor({ state: 'hidden' });
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 21 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=2&date=2026-10-08&mainTask=arena_weekly');
          await taskPicker.click(); await f.page.getByRole('option', { name: '刷日常', exact: true }).click();
          await dialog.getByText('共 3 条 · 第 1 页 / 1 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1&date=2026-10-08&mainTask=daily');
          assert.equal(await datePicker.innerText(), '2026-10-08（今天）');
          await taskPicker.click(); await f.page.getByRole('option', { name: '刷周胜', exact: true }).click();
          await dialog.getByText('共 21 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 21 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          await datePicker.click(); await f.page.getByRole('option', { name: '2026-10-07（昨天）', exact: true }).click();
          await dialog.getByText('2026-10-07 · 1 次申请', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1&date=2026-10-07&mainTask=arena_weekly');
          assert.match(await dialog.innerText(), /Weekly_Yesterday/);
          await dialog.getByRole('button', { name: '刷新', exact: true }).click();
          await f.page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1&date=2026-10-07&mainTask=arena_weekly');
          await datePicker.click(); await f.page.getByRole('option', { name: '2026-10-06', exact: true }).click();
          await dialog.getByText('这一天没有周胜申请', { exact: true }).waitFor();
          await datePicker.click(); await f.page.getByRole('option', { name: '全部七天', exact: true }).click();
          await dialog.getByText('共 22 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1&mainTask=arena_weekly');
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 22 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          assert.match(await dialog.innerText(), /Weekly_Yesterday/);
          const readsBeforeTypeChange = f.state.adminReads.length;
          await taskPicker.click(); await f.page.getByRole('option', { name: '刷日常', exact: true }).click();
          await dialog.getByText('共 3 条 · 第 1 页 / 1 页', { exact: true }).waitFor();
          assert.equal(await datePicker.innerText(), '全部七天');
          assert.deepEqual(f.state.adminReads.slice(readsBeforeTypeChange), ['/api/admin/daily-tasks?page=1&mainTask=daily']);
          f.state.extraDaily = [];
          await taskPicker.click(); await f.page.getByRole('option', { name: '刷周胜', exact: true }).click();
          await dialog.getByText('近七天还没有周胜申请', { exact: true }).waitFor();
          await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
          const readsBeforeReopen = f.state.adminReads.length;
          await f.open('近七天扫码情况');
          await dialog.getByText('共 3 条 · 第 1 页 / 1 页', { exact: true }).waitFor();
          assert.equal(await taskPicker.innerText(), '刷日常');
          assert.equal(await datePicker.innerText(), '2026-10-08（今天）');
          assert.deepEqual(f.state.adminReads.slice(readsBeforeReopen), ['/api/admin/daily-tasks?page=1&date=2026-10-08&mainTask=daily']);
          assert.deepEqual(f.state.mutations, []);
        } finally { await f.close(); }
      }
    });

    await t.test('monthly rankings switch metrics/months and fit desktop and mobile', async () => {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const f = await fixture(true, viewport);
        try {
          await f.open('月度排行榜');
          const dialog = f.page.getByRole('dialog', { name: '月度排行榜' });
          await dialog.getByRole('cell', { name: 'Naruto_01', exact: true }).waitFor();
          assert.match(await dialog.innerText(), /2 人参与 · 共 42 次申请/);
          assert.match(await dialog.getByRole('row').nth(1).innerText(), /Naruto_01/);
          await dialog.getByRole('button', { name: '日常天数榜' }).click();
          await f.page.waitForFunction(() => document.querySelector('tbody tr')?.textContent?.includes('Sasuke_02'));
          const bounds = await dialog.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
          assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), 'ranking must fit without horizontal overflow');
          assert.equal(await dialog.getByRole('button', { name: '日常天数榜' }).getAttribute('aria-pressed'), 'true');
          await f.page.screenshot({ animations: 'disabled', path: path.join(repository, `.data/admin-preview/monthly-${viewport.width < 768 ? 'mobile' : 'desktop'}.png`) });
          await dialog.getByLabel('统计月份').fill('2020-01');
          await dialog.getByText('这个月还没有日常申请。').waitFor();
          f.state.access = false;
          await dialog.getByRole('button', { name: '刷新', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
        } finally { await f.close(); }
      }
    });

    await t.test('daily tasks default to Beijing today on every open, while date selection resets pagination on desktop and mobile', async () => {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const f = await fixture(true, viewport, viewport.width < 768);
        try {
          f.state.extraDaily.push(...Array.from({ length: 21 }, (_, index) => ({ ...task, id: `extra-${index}`, username: `Extra_${index}` })),
            { ...task, id: 'yesterday', username: 'Yesterday_User', requestedAt: '2026-10-07T00:00:00Z', scannedAt: null, completedAt: null, status: 'waiting_scan' });
          await f.open('近七天扫码情况');
          const dialog = f.page.getByRole('dialog', { name: '近七天扫码情况' });
          await dialog.getByText('共 24 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.deepEqual(f.state.adminReads, ['/api/admin/daily-tasks?page=1&date=2026-10-08&mainTask=daily'], 'Opening must request today directly without an all-seven-days request');
          const picker = dialog.getByRole('combobox', { name: '查看日期' });
          assert.equal(await picker.innerText(), '2026-10-08（今天）');
          assert.match(await dialog.innerText(), /2026-10-08 · 24 次申请/);
          assert.doesNotMatch(await dialog.innerText(), /Yesterday_User/);
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 24 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=2&date=2026-10-08&mainTask=daily');
          await picker.click();
          assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['全部七天', '2026-10-08（今天）', '2026-10-07（昨天）',
            '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
          await f.page.screenshot({ animations: 'disabled', path: path.join(repository, `.data/admin-preview/date-picker-${viewport.width < 768 ? 'mobile' : 'desktop'}.png`) });
          await f.page.getByRole('option', { name: '2026-10-07（昨天）', exact: true }).click();
          await dialog.getByText('2026-10-07 · 1 次申请', { exact: true }).waitFor();
          assert.match(f.state.adminReads.at(-1), /^\/api\/admin\/daily-tasks\?page=1&date=2026-10-07&mainTask=daily$/);
          assert.match(await dialog.innerText(), /Yesterday_User/);
          assert.doesNotMatch(await dialog.innerText(), /Naruto_01|Sakura_03|Extra_/);
          assert.equal(await dialog.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
          await dialog.getByRole('button', { name: '刷新', exact: true }).click();
          await f.page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
          assert.match(f.state.adminReads.at(-1), /page=1&date=2026-10-07&mainTask=daily$/);
          assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
          await f.page.screenshot({ animations: 'disabled', path: path.join(repository, `.data/admin-preview/daily-filtered-${viewport.width < 768 ? 'mobile' : 'desktop'}.png`) });
          await picker.click(); await f.page.getByRole('option', { name: '2026-10-06', exact: true }).click();
          await dialog.getByText('这一天没有日常申请', { exact: true }).waitFor();
          await picker.click(); await f.page.getByRole('option', { name: '全部七天', exact: true }).click();
          await dialog.getByText('共 25 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1&mainTask=daily');
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 25 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          assert.match(await dialog.innerText(), /Yesterday_User/);
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=2&mainTask=daily');
          await dialog.getByRole('button', { name: 'Close', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          const readsBeforeReopen = f.state.adminReads.length;
          await f.open('近七天扫码情况');
          await dialog.getByText('共 24 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.equal(await picker.innerText(), '2026-10-08（今天）');
          assert.deepEqual(f.state.adminReads.slice(readsBeforeReopen), ['/api/admin/daily-tasks?page=1&date=2026-10-08&mainTask=daily'], 'Reopening resets both date and page before requesting data');
          assert.deepEqual(f.state.mutations, []);
        } finally { await f.close(); }
      }
    });

    await t.test('daily table has a separate log column and every task state opens real logs only on click', async () => {
      const f = await fixture();
      try {
        const statuses = { queued: '排队中', starting_emulator: '启动模拟器', opening_game: '打开游戏', preparing_qr: '生成二维码',
          waiting_scan: '等待扫码', finishing_login: '进入游戏', interrupted: '已中断', expired: '已过期', unavailable: '执行记录不可用' };
        f.state.extraDaily.push(...Object.entries(statuses).map(([status], index) => ({ ...task, id: `status-${index}`, username: `State_${status}`, status })));
        const literal = '<img src="unsafe-log-image" onerror="window.unsafeLog=true">';
        f.state.detailResponse.logs.push({ id: '1003-0', time: task.requestedAt, level: 'INFO', message: literal });
        await f.open('近七天扫码情况');
        const list = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
        await list.getByRole('cell', { name: user.username, exact: true }).waitFor();
        assert.deepEqual(await list.getByRole('columnheader').allTextContents(), ['用户名', '登录渠道', '申请时间', '扫描完成时间', '脚本执行完成时间', '任务状态', '操作']);
        assert.match(await list.innerText(), /08:02:00/); assert.match(await list.innerText(), /08:30:00/);
        assert.equal(await list.getByRole('button', { name: /的日志详情$/ }).count(), 12);
        await mkdir(path.join(repository, '.data/admin-preview'), { recursive: true });
        await f.page.screenshot({ animations: 'disabled', path: path.join(repository, '.data/admin-preview/task-log-column-desktop.png') });
        const triggers = [[user.username, '已完成'], ['Sasuke_02', '刷日常中'], ['Sakura_03', '失败'],
          ...Object.entries(statuses).map(([status, label]) => [`State_${status}`, label])];
        await list.getByRole('button', { name: 'Sakura_03的日志详情', exact: true }).hover();
        assert.equal(f.state.adminReads.some(path => path.includes('/logs?')), false, 'Opening or hovering the list must not fetch any logs');
        for (const [username, label] of triggers) {
          await list.getByRole('button', { name: `${username}的日志详情`, exact: true }).click();
          const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
          await details.getByRole('listitem').last().waitFor();
          await details.getByText(label, { exact: true }).waitFor();
          assert.equal(await details.getByRole('listitem').count(), 4);
          assert.match(await details.innerText(), /INFO/); assert.match(await details.innerText(), /WARNING/); assert.match(await details.innerText(), /ERROR/);
          assert.equal(await details.getByText(literal, { exact: true }).isVisible(), true);
          assert.equal(await details.locator('img').count(), 0, 'Log text never becomes HTML');
          if (!['失败', '已中断', '已过期'].includes(label)) assert.doesNotMatch(await details.innerText(), /日常任务执行失败|失败步骤|未记录具体错误原因/);
          await details.getByRole('button', { name: '关闭日志详情' }).click();
          await details.waitFor({ state: 'hidden' });
          assert.equal(await list.isVisible(), true);
        }
        f.state.failDaily = true;
        await list.getByRole('button', { name: '刷新', exact: true }).click();
        await list.getByRole('alert').waitFor();
        assert.equal(await list.getByRole('cell', { name: user.username, exact: true }).count(), 1);
        assert.deepEqual(f.state.mutations, []);
      } finally { await f.close(); }
    });

    await t.test('confirmed daily completion stays completed when raw logs report a later worker timeout on desktop and mobile', async () => {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const f = await fixture(true, viewport, viewport.width < 768);
        try {
          const confirmed = { ...task, id: 'confirmed-daily', username: 'Confirmed_Daily',
            errorCode: 'daily_timeout', errorMessage: '首次秘境已完成，后续 worker 进程超时。' };
          const timeout = { errorCode: 'daily_timeout', errorMessage: '日常任务执行超时，请查看执行日志。' };
          const errorLog = 'daily_timeout：首次秘境完成后，worker 执行超时。';
          f.state.extraDaily.push(confirmed);
          f.state.failureDetails = timeout;
          f.state.detailResponse.status = 'failed';
          f.state.detailResponse.errorCode = timeout.errorCode;
          f.state.detailResponse.errorMessage = timeout.errorMessage;
          f.state.detailResponse.logs = [
            { id: '1000-0', time: task.completedAt, level: 'INFO', message: '首次秘境已完成。' },
            { id: '1001-0', time: '2026-10-08T00:31:00.000Z', level: 'ERROR', message: errorLog },
          ];
          await f.open('近七天扫码情况');
          const list = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
          const completedRow = (viewport.width < 768
            ? list.getByRole('list', { name: '近七天任务列表' }).getByRole('listitem')
            : list.getByRole('row')).filter({ hasText: confirmed.username });
          await completedRow.getByText('已完成', { exact: true }).waitFor();
          await completedRow.getByRole('button', { name: `${confirmed.username}的日志详情`, exact: true }).click();
          const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
          await details.getByText('已加载 2 条', { exact: true }).waitFor();
          await details.getByText('已完成', { exact: true }).waitFor();
          assert.equal(await details.getByText('失败', { exact: true }).count(), 0,
            'A saved daily completion is not replaced by the raw worker failure');
          assert.equal(await details.getByText(confirmed.errorMessage, { exact: true }).count(), 0);
          assert.equal(await details.getByText('错误码：daily_timeout', { exact: true }).count(), 0);
          assert.equal(await details.getByText(errorLog, { exact: true }).isVisible(), true,
            'The original ERROR log remains available after daily completion');
          assert.match(await details.getByRole('listitem').last().innerText(), /ERROR/);
          await details.getByRole('button', { name: '关闭日志详情' }).click();
          await details.waitFor({ state: 'hidden' });

          await list.getByRole('button', { name: 'Sakura_03的日志详情', exact: true }).click();
          await details.getByText('已加载 2 条', { exact: true }).waitFor();
          await details.getByText('失败', { exact: true }).waitFor();
          assert.equal(await details.getByText('已完成', { exact: true }).count(), 0,
            'A task without confirmed daily completion still shows its genuine failure');
          assert.equal(await details.getByText(timeout.errorMessage, { exact: true }).isVisible(), true);
          assert.equal(await details.getByText('错误码：daily_timeout', { exact: true }).isVisible(), true);
          assert.equal(await details.getByText(errorLog, { exact: true }).isVisible(), true);
          assert.deepEqual(f.state.mutations, []);
        } finally { await f.close(); }
      }
    });

    await t.test('log details manually load stable snapshot pages and preserve previous logs through retry', async () => {
      const f = await fixture();
      let release;
      try {
        f.state.detailResponse.logs = Array.from({ length: 105 }, (_, index) => ({ id: `${index + 1}-0`, time: task.requestedAt, level: 'INFO', message: `分页日志 ${index + 1}` }));
        await f.open('近七天扫码情况');
        const list = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
        const trigger = list.getByRole('button', { name: `${user.username}的日志详情`, exact: true });
        await trigger.click();
        const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
        await details.getByText('已加载 100 条', { exact: true }).waitFor();
        const reads = () => f.state.adminReads.filter(path => path.includes('/logs?'));
        assert.equal(reads().length, 1, 'Opening reads one page only');
        assert.match(reads()[0], /\/logs\?after=0-0$/);
        assert.equal(await list.locator('[aria-busy="true"]').count(), 0, 'Log reads never keep the task list loading');
        await details.getByRole('button', { name: '加载更多', exact: true }).scrollIntoViewIfNeeded();
        await f.page.screenshot({ animations: 'disabled', path: path.join(repository, '.data/admin-preview/task-log-pagination-desktop.png') });
        f.state.detailResponse.logs.push({ id: '106-0', time: task.requestedAt, level: 'INFO', message: '快照之后的新日志' });
        f.state.moreGate = new Promise(done => { release = done; });
        const more = details.getByRole('button', { name: '加载更多', exact: true });
        await more.click();
        assert.equal(await more.isDisabled(), true);
        assert.equal(await details.getByRole('listitem').count(), 100, 'Existing logs stay mounted while the next page loads');
        f.state.detailStatus = 503; release(); f.state.moreGate = null;
        await details.getByRole('alert').waitFor();
        assert.equal(await details.getByRole('listitem').count(), 100);
        f.state.detailStatus = 200;
        await details.getByRole('button', { name: '重试读取' }).click();
        await details.getByText('已加载 105 条', { exact: true }).waitFor();
        assert.equal(await details.getByRole('listitem').count(), 105);
        assert.equal(await details.getByText('分页日志 1', { exact: true }).count(), 1);
        assert.equal(await details.getByText('快照之后的新日志', { exact: true }).count(), 0);
        assert.equal(await details.getByRole('button', { name: '加载更多' }).count(), 0);
        assert.equal(reads()[1], reads()[2], 'Retry uses the same successful cursor and snapshot');
        assert.match(reads()[1], /after=100-0&snapshot=105-0$/);
        await details.getByRole('button', { name: '关闭日志详情' }).click();
        await details.waitFor({ state: 'hidden' });
        await trigger.click();
        await details.getByText('已加载 100 条', { exact: true }).waitFor();
        await details.getByRole('button', { name: '加载更多' }).click();
        await details.getByText('已加载 106 条', { exact: true }).waitFor();
        await details.getByText('快照之后的新日志', { exact: true }).waitFor();
        assert.deepEqual(f.state.mutations, []);
      } finally { release?.(); await f.close(); }
    });

    await t.test('log details reject another task, show honest empty state and close on lost admin access', async () => {
      const f = await fixture();
      try {
        await f.open('近七天扫码情况');
        const list = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
        const trigger = list.getByRole('button', { name: 'Sakura_03的日志详情', exact: true });
        f.state.detailIdentityOverride = 'another-task';
        await trigger.click();
        const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
        await details.getByRole('alert').waitFor();
        assert.doesNotMatch(await details.innerText(), /VisualError/);
        await f.page.keyboard.press('Escape'); await details.waitFor({ state: 'hidden' });
        assert.equal(await list.isVisible(), true);
        assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
        f.state.detailIdentityOverride = null;
        f.state.detailResponse.logs = [];
        await trigger.click();
        await details.getByText('暂无已保留的执行日志，记录可能尚未上报或已过期。', { exact: true }).waitFor();
        assert.equal(await details.getByRole('button', { name: '加载更多' }).count(), 0);
        await details.getByRole('button', { name: '关闭日志详情' }).click();
        await details.waitFor({ state: 'hidden' });
        f.state.access = false;
        await trigger.click();
        await list.waitFor({ state: 'hidden' }); await details.waitFor({ state: 'hidden' });
        assert.equal(await f.page.getByRole('tooltip').count(), 0);
      } finally { await f.close(); }
    });

    await t.test('long desktop logs scroll inside the dialog while the close button remains fixed', async () => {
      const f = await fixture();
      try {
        f.state.detailResponse.logs = Array.from({ length: 10 }, (_, index) => ({ id: `1000-${index}`, time: task.requestedAt,
          level: index === 9 ? 'ERROR' : 'WARNING', message: `记录 ${index + 1}：${'装备材料识别失败，重新截图后重试。'.repeat(10)}` }));
        f.state.detailResponse.truncated = true;
        await f.open('近七天扫码情况');
        await f.page.getByRole('button', { name: 'Sakura_03的日志详情', exact: true }).click();
        const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
        await details.getByText('执行日志', { exact: true }).waitFor();
        await details.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
        const scroll = details.getByRole('region', { name: '任务执行日志', exact: true });
        assert.ok(await scroll.evaluate(element => element.scrollHeight > element.clientHeight));
        const close = details.getByRole('button', { name: '关闭日志详情' });
        const before = await close.boundingBox();
        await scroll.hover(); await f.page.mouse.wheel(0, 300);
        await f.page.waitForFunction(() => (document.querySelector('[data-slot="task-log-details-scroll"]')?.scrollTop ?? 0) > 0);
        assert.deepEqual(await close.boundingBox(), before);
        assert.equal(await details.isVisible(), true);
      } finally { await f.close(); }
    });

    await t.test('touch tasks all have log buttons and long logs scroll with a fixed close button in every orientation', async () => {
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
        const f = await fixture(true, viewport, true);
        try {
          f.state.detailResponse.logs = Array.from({ length: 10 }, (_, index) => ({ id: `1000-${index}`, time: task.requestedAt,
            level: index === 9 ? 'ERROR' : 'WARNING', message: `记录 ${index + 1}：${'request_id=long_unbroken_token_'.repeat(12)}` }));
          f.state.detailResponse.truncated = true;
          await f.open('近七天扫码情况');
          const list = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
          const trigger = list.getByRole('button', { name: 'Sakura_03的日志详情', exact: true });
          await trigger.waitFor();
          assert.equal(await list.getByRole('button', { name: /的日志详情$/ }).count(), 3);
          if (viewport.width < 768) {
            assert.equal(await list.getByRole('table').count(), 0);
            assert.equal(await list.getByRole('list', { name: '近七天任务列表' }).getByRole('listitem').count(), 3);
          }
          assert.equal(await list.evaluate(element => element.scrollWidth <= element.clientWidth), true);
          assert.equal(f.state.adminReads.some(path => path.includes('/logs?')), false);
          await trigger.scrollIntoViewIfNeeded();
          assert.ok((await trigger.boundingBox()).height >= 44);
          await trigger.tap();
          const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
          await details.getByText('已加载 10 条', { exact: true }).waitFor();
          await details.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
          const box = await details.boundingBox();
          assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1);
          assert.ok(box.y >= -1 && box.y + box.height <= viewport.height + 1);
          const scroll = details.getByRole('region', { name: '任务执行日志', exact: true });
          assert.equal(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth), true);
          assert.equal(await scroll.evaluate(element => element.scrollHeight > element.clientHeight), true);
          const close = details.getByRole('button', { name: '关闭日志详情' });
          const closeBox = await close.boundingBox();
          assert.ok(closeBox.height >= 44 && closeBox.width >= 44);
          const area = await scroll.boundingBox();
          const cdp = await f.context.newCDPSession(f.page);
          const x = area.x + area.width / 2, start = area.y + area.height * .8, end = area.y + area.height * .2;
          const finished = scroll.evaluate(element => new Promise(resolve => element.addEventListener('scrollend', () => resolve(true), { once: true })));
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
          for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 8 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await f.page.waitForFunction(() => (document.querySelector('[data-slot="task-log-details-scroll"]')?.scrollTop ?? 0) > 0);
          await finished; await cdp.detach();
          if (viewport.width === 390 || viewport.width === 844) await f.page.screenshot({ animations: 'disabled',
            path: path.join(repository, `.data/admin-preview/task-log-mobile-${viewport.width === 844 ? 'landscape' : 'portrait'}.png`) });
          assert.deepEqual(await close.boundingBox(), closeBox, 'Close remains fixed after touch scrolling, including landscape');
          await close.tap(); await details.waitFor({ state: 'hidden' });
          assert.equal(await list.isVisible(), true);
          assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
          assert.deepEqual(f.state.mutations, []);
        } finally { await f.close(); }
      }
    });

    await t.test('mobile log details retry read errors and dismiss after permission loss', async () => {
      const f = await fixture(true, { width: 390, height: 844 }, true);
      try {
        f.state.detailStatus = 503;
        await f.open('近七天扫码情况');
        const list = f.page.getByRole('dialog', { name: '近七天扫码情况', exact: true });
        await list.getByRole('button', { name: 'Sakura_03的日志详情', exact: true }).tap();
        const details = f.page.getByRole('dialog', { name: '日志详情', exact: true });
        await details.getByRole('alert').waitFor();
        f.state.detailStatus = 200;
        await details.getByRole('button', { name: '重试读取' }).tap();
        await details.getByText('已加载 3 条', { exact: true }).waitFor();
        await details.getByRole('button', { name: '关闭日志详情' }).tap(); await details.waitFor({ state: 'hidden' });
        f.state.access = false;
        await list.getByRole('button', { name: 'Sakura_03的日志详情', exact: true }).tap();
        await list.waitFor({ state: 'hidden' }); await details.waitFor({ state: 'hidden' });
      } finally { await f.close(); }
    });

    await t.test('create, inspect, search, edit and delete users with shadcn dialogs', async () => {
      const f = await fixture();
      try {
        await f.open('用户管理');
        const list = f.page.getByRole('dialog', { name: '用户管理', exact: true });
        await list.getByRole('cell', { name: user.username, exact: true }).waitFor();
        assert.equal(await list.getByRole('button', { name: `删除 ${admin.username}`, exact: true }).isDisabled(), true);
        await f.page.screenshot({ path: path.join(repository, '.data/admin-preview/users-desktop.png') });
        await list.getByRole('button', { name: '新增用户', exact: true }).click();
        const create = f.page.getByRole('dialog', { name: '新增用户', exact: true });
        await create.getByLabel('用户名', { exact: true }).fill('New_User'); await create.getByLabel('登录密码', { exact: true }).fill('fixture-password');
        await create.getByRole('button', { name: '创建用户', exact: true }).click();
        await list.getByRole('cell', { name: 'New_User', exact: true }).waitFor();
        assert.equal(f.state.mutations.at(-1).method, 'POST');
        assert.deepEqual(f.state.mutations.at(-1).body, { username: 'New_User', password: 'fixture-password', isAdmin: false, isInvalid: false });
        await list.getByRole('button', { name: '查看 New_User', exact: true }).click();
        const view = f.page.getByRole('dialog', { name: '查看用户', exact: true });
        await view.getByLabel('用户名', { exact: true }).waitFor();
        assert.equal(await view.getByLabel('用户名', { exact: true }).inputValue(), 'New_User');
        assert.equal(await view.locator('input[type="password"]').count(), 0);
        await view.getByRole('button', { name: '关闭', exact: true }).click();
        await list.getByRole('button', { name: '编辑 New_User', exact: true }).click();
        const edit = f.page.getByRole('dialog', { name: '编辑用户', exact: true });
        await edit.getByLabel('用户名', { exact: true }).fill('Edited_User');
        await edit.getByLabel('账号状态', { exact: true }).click(); await f.page.getByRole('option', { name: '停用', exact: true }).click();
        await edit.getByRole('button', { name: '保存修改', exact: true }).click();
        await list.getByRole('cell', { name: 'Edited_User', exact: true }).waitFor();
        assert.equal(f.state.mutations.at(-1).body.password, ''); assert.equal(f.state.mutations.at(-1).body.isInvalid, true);
        await list.getByRole('textbox', { name: '搜索用户名', exact: true }).fill('Edited');
        await list.getByRole('button', { name: '搜索', exact: true }).click();
        await list.getByText('共 1 条 · 第 1 页 / 1 页', { exact: true }).waitFor();
        await list.getByRole('button', { name: '删除 Edited_User', exact: true }).click();
        const confirmation = f.page.getByRole('alertdialog');
        await confirmation.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(f.state.mutations.filter(value => value.method === 'DELETE').length, 0);
        await list.getByRole('button', { name: '删除 Edited_User', exact: true }).click();
        await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
        await list.getByText('没有匹配的用户', { exact: true }).waitFor();
        assert.equal(f.state.mutations.at(-1).method, 'DELETE');
      } finally { await f.close(); }
    });

    await t.test('ordinary users cannot see admin menu or initiate administrator reads', async () => {
      const f = await fixture(false);
      try { assert.equal(await f.page.getByRole('button', { name: '管理员', exact: true }).count(), 0); assert.deepEqual(f.state.adminReads, []); }
      finally { await f.close(); }
    });

    await t.test('pagination exposes all users and closing a modal restores menu focus', async () => {
      const f = await fixture();
      try {
        f.state.users.push(...Array.from({ length: 21 }, (_, index) => ({ ...user, id: `user-${index}`, username: `Extra_${index}` })));
        await f.open('用户管理'); const list = f.page.getByRole('dialog', { name: '用户管理', exact: true });
        await list.getByText('共 23 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
        assert.equal(await list.getByRole('row').count(), 21);
        await list.getByRole('button', { name: '下一页', exact: true }).click();
        await list.getByText('共 23 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
        assert.equal(await list.getByRole('row').count(), 4);
        await f.page.keyboard.press('Escape'); await list.waitFor({ state: 'hidden' });
        assert.equal(await f.page.getByRole('button', { name: '管理员', exact: true }).evaluate(element => element === document.activeElement), true);
      } finally { await f.close(); }
    });

    await t.test('duplicate usernames keep create form open with a useful error; self edit disables role and state', async () => {
      const f = await fixture();
      try {
        await f.open('用户管理'); const list = f.page.getByRole('dialog', { name: '用户管理', exact: true });
        await list.getByRole('cell', { name: user.username, exact: true }).waitFor();
        await list.getByRole('button', { name: '新增用户', exact: true }).click();
        const create = f.page.getByRole('dialog', { name: '新增用户', exact: true });
        await create.getByLabel('用户名', { exact: true }).fill(user.username); await create.getByLabel('登录密码', { exact: true }).fill('fixture-password');
        await create.getByRole('button', { name: '创建用户', exact: true }).click(); await create.getByRole('alert').waitFor();
        assert.match(await create.getByRole('alert').innerText(), /该用户名已被注册/);
        await create.getByRole('button', { name: '取消', exact: true }).click();
        await list.getByRole('button', { name: `编辑 ${admin.username}`, exact: true }).click();
        const edit = f.page.getByRole('dialog', { name: '编辑用户', exact: true }); await edit.getByLabel('用户名', { exact: true }).waitFor();
        assert.equal(await edit.getByLabel('用户角色', { exact: true }).isDisabled(), true);
        assert.equal(await edit.getByLabel('账号状态', { exact: true }).isDisabled(), true);
      } finally { await f.close(); }
    });

    await t.test('losing admin access closes the list and clears sensitive data', async () => {
      const f = await fixture();
      try {
        await f.open('用户管理'); const list = f.page.getByRole('dialog', { name: '用户管理', exact: true });
        await list.getByRole('cell', { name: user.username, exact: true }).waitFor();
        f.state.access = false; await list.getByRole('button', { name: '刷新', exact: true }).click();
        await list.waitFor({ state: 'hidden' }); await f.page.getByRole('button', { name: '管理员', exact: true }).waitFor({ state: 'hidden' });
        assert.equal(await f.page.getByRole('cell', { name: user.username, exact: true }).count(), 0);
      } finally { await f.close(); }
    });

    await t.test('mobile table scrolls inside dialog and editor remains within viewport', async () => {
      const f = await fixture(true, { width: 390, height: 844 });
      try {
        await f.open('用户管理'); const list = f.page.getByRole('dialog', { name: '用户管理', exact: true });
        await list.getByRole('cell', { name: user.username, exact: true }).waitFor();
        const bounds = await list.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        await f.page.screenshot({ path: path.join(repository, '.data/admin-preview/users-mobile.png') });
        await list.getByRole('button', { name: '新增用户', exact: true }).click();
        const editor = f.page.getByRole('dialog', { name: '新增用户', exact: true }); await editor.getByLabel('用户名', { exact: true }).waitFor();
        const editBounds = await editor.boundingBox(); assert.ok(editBounds.x >= 0 && editBounds.x + editBounds.width <= 390);
        await f.page.screenshot({ path: path.join(repository, '.data/admin-preview/editor-mobile.png') });
      } finally { await f.close(); }
    });
  } finally { await browser?.close(); await server.close(); await rmdir(envDir); }
});
