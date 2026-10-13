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
const task = { id: '20000000-0000-4000-8000-000000000001', username: user.username,
  requestedAt: '2026-10-08T00:00:00.000Z', scannedAt: '2026-10-08T00:02:00.000Z', completedAt: '2026-10-08T00:30:00.000Z', status: 'completed' };

test('administrator menu, daily tasks and user CRUD', { skip: skip || false, timeout: 120_000 }, async t => {
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
        failureDetails: { errorCode: 'daily_failed', errorMessage: '日常任务执行失败，请查看执行日志。' }, detailStatus: 200,
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
        if (url.pathname === '/api/auth/me') return reply({ user: { ...admin, isAdmin: state.access } });
        if (url.pathname === '/api/task-runs/latest') return reply({ task: null });
        if (url.pathname.startsWith('/api/admin/')) {
          if (!state.access) return reply({ error: '需要管理员权限。' }, 403);
          if (method === 'GET') state.adminReads.push(url.pathname + url.search);
          else state.mutations.push({ path: url.pathname, method, body: route.request().postDataJSON() });
          if (url.pathname.endsWith('/failure-details')) return reply(state.detailStatus === 200 ? state.detailResponse
            : { error: '任务日志暂时不可用，请稍后重试。' }, state.detailStatus);
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
            const items = [task, { ...task, id: 'running', username: 'Sasuke_02', scannedAt: null, completedAt: null, status: 'running_daily' },
              { ...task, id: 'failed', username: 'Sakura_03', completedAt: null, status: 'failed', ...state.failureDetails }, ...state.extraDaily]
              .filter(item => !selectedDate || new Date(Date.parse(item.requestedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === selectedDate);
            return reply({ items: items.slice((page - 1) * 20, page * 20), total: items.length, page, pageSize: 20,
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
          await f.open('近七天刷日常情况');
          const dialog = f.page.getByRole('dialog', { name: '近七天刷日常情况' });
          await dialog.getByText('共 24 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.deepEqual(f.state.adminReads, ['/api/admin/daily-tasks?page=1&date=2026-10-08'], 'Opening must request today directly without an all-seven-days request');
          const picker = dialog.getByRole('combobox', { name: '查看日期' });
          assert.equal(await picker.innerText(), '2026-10-08（今天）');
          assert.match(await dialog.innerText(), /2026-10-08 · 24 次申请/);
          assert.doesNotMatch(await dialog.innerText(), /Yesterday_User/);
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 24 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=2&date=2026-10-08');
          await picker.click();
          assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['全部七天', '2026-10-08（今天）', '2026-10-07（昨天）',
            '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
          await f.page.screenshot({ animations: 'disabled', path: path.join(repository, `.data/admin-preview/date-picker-${viewport.width < 768 ? 'mobile' : 'desktop'}.png`) });
          await f.page.getByRole('option', { name: '2026-10-07（昨天）', exact: true }).click();
          await dialog.getByText('2026-10-07 · 1 次申请', { exact: true }).waitFor();
          assert.match(f.state.adminReads.at(-1), /^\/api\/admin\/daily-tasks\?page=1&date=2026-10-07$/);
          assert.match(await dialog.innerText(), /Yesterday_User/);
          assert.doesNotMatch(await dialog.innerText(), /Naruto_01|Sakura_03|Extra_/);
          assert.equal(await dialog.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
          await dialog.getByRole('button', { name: '刷新', exact: true }).click();
          await f.page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
          assert.match(f.state.adminReads.at(-1), /page=1&date=2026-10-07$/);
          assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
          await f.page.screenshot({ animations: 'disabled', path: path.join(repository, `.data/admin-preview/daily-filtered-${viewport.width < 768 ? 'mobile' : 'desktop'}.png`) });
          await picker.click(); await f.page.getByRole('option', { name: '2026-10-06', exact: true }).click();
          await dialog.getByText('这一天没有日常申请', { exact: true }).waitFor();
          await picker.click(); await f.page.getByRole('option', { name: '全部七天', exact: true }).click();
          await dialog.getByText('共 25 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=1');
          await dialog.getByRole('button', { name: '下一页', exact: true }).click();
          await dialog.getByText('共 25 条 · 第 2 页 / 2 页', { exact: true }).waitFor();
          assert.match(await dialog.innerText(), /Yesterday_User/);
          assert.equal(f.state.adminReads.at(-1), '/api/admin/daily-tasks?page=2');
          await dialog.getByRole('button', { name: 'Close', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          const readsBeforeReopen = f.state.adminReads.length;
          await f.open('近七天刷日常情况');
          await dialog.getByText('共 24 条 · 第 1 页 / 2 页', { exact: true }).waitFor();
          assert.equal(await picker.innerText(), '2026-10-08（今天）');
          assert.deepEqual(f.state.adminReads.slice(readsBeforeReopen), ['/api/admin/daily-tasks?page=1&date=2026-10-08'], 'Reopening resets both date and page before requesting data');
          assert.deepEqual(f.state.mutations, []);
        } finally { await f.close(); }
      }
    });

    await t.test('daily table displays requested columns, Beijing timestamps and keeps data on refresh failure', async () => {
      const f = await fixture();
      try {
        await f.open('近七天刷日常情况');
        const dialog = f.page.getByRole('dialog', { name: '近七天刷日常情况' });
        await dialog.getByRole('cell', { name: user.username, exact: true }).waitFor();
        assert.deepEqual(await dialog.getByRole('columnheader').allTextContents(), ['用户名', '登录渠道', '申请时间', '扫描完成时间', '脚本执行完成时间', '任务状态']);
        assert.match(await dialog.innerText(), /08:02:00/); assert.match(await dialog.innerText(), /08:30:00/);
        assert.match(await dialog.innerText(), /刷日常中/); assert.match(await dialog.innerText(), /失败/);
        const details = dialog.getByRole('button', { name: 'Sakura_03的失败详情', exact: true });
        assert.equal(await dialog.getByRole('button', { name: /的失败详情$/ }).count(), 1);
        assert.match(await details.locator('..').innerText(), /失败\s*详情/);
        assert.equal(f.state.adminReads.some(path => path.endsWith('/failure-details')), false, 'list must not fetch logs before hover');
        await details.hover();
        const tooltip = f.page.getByRole('tooltip');
        await tooltip.getByText('相关执行日志', { exact: true }).waitFor();
        assert.match(await tooltip.innerText(), /VisualError: 未能识别装备材料页面/);
        assert.match(await tooltip.innerText(), /失败步骤：装备进阶（18\/35）/);
        assert.match(await tooltip.innerText(), /错误码：daily_failed/);
        assert.deepEqual(await tooltip.getByRole('listitem').locator('p:last-child').allTextContents(), f.state.detailResponse.logs.map(log => log.message));
        await mkdir(path.join(repository, '.data/admin-preview'), { recursive: true });
        await f.page.screenshot({ path: path.join(repository, '.data/admin-preview/daily-desktop.png') });
        const dismissDetails = async () => {
          const close = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox();
          await f.page.mouse.move(close.x + close.width / 2, close.y + close.height / 2, { steps: 10 });
          await tooltip.waitFor({ state: 'hidden' });
        };
        await dismissDetails();
        await details.focus(); await tooltip.waitFor();
        await f.page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
        assert.equal(await dialog.isVisible(), true, 'Escape closes failure details without closing the daily task list');
        f.state.failureDetails = {};
        f.state.detailResponse = { taskId: 'failed', errorMessage: '未记录具体错误原因。', logs: [], truncated: false };
        await dialog.getByRole('button', { name: '刷新', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
        await details.hover();
        await tooltip.getByText('未保留执行日志，无法还原具体失败过程。', { exact: true }).waitFor();
        assert.match(await tooltip.innerText(), /未记录具体错误原因。/);
        await dismissDetails();
        f.state.failDaily = true; await dialog.getByRole('button', { name: '刷新', exact: true }).click();
        await dialog.getByRole('alert').waitFor(); assert.match(await dialog.innerText(), /任务日志暂时不可用/);
        assert.equal(await dialog.getByRole('cell', { name: user.username, exact: true }).count(), 1);
      } finally { await f.close(); }
    });

    await t.test('failure details reject other tasks, retry temporary errors and close on lost admin access', async () => {
      const f = await fixture();
      try {
        await f.open('近七天刷日常情况');
        const dialog = f.page.getByRole('dialog', { name: '近七天刷日常情况' });
        const details = dialog.getByRole('button', { name: 'Sakura_03的失败详情', exact: true });
        f.state.detailResponse.taskId = 'another-task';
        await details.hover();
        let tooltip = f.page.getByRole('tooltip');
        await tooltip.getByRole('alert').waitFor();
        assert.doesNotMatch(await tooltip.innerText(), /VisualError/);
        await f.page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
        f.state.detailStatus = 503;
        await dialog.getByRole('heading').hover(); await details.hover();
        await tooltip.getByRole('alert').waitFor();
        assert.match(await tooltip.innerText(), /任务日志暂时不可用/);
        await f.page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
        f.state.detailStatus = 200; f.state.detailResponse.taskId = 'failed';
        await dialog.getByRole('heading').hover(); await details.hover();
        await tooltip.getByText('相关执行日志', { exact: true }).waitFor();
        assert.match(await tooltip.innerText(), /VisualError/);
        await f.page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
        f.state.access = false;
        await dialog.getByRole('heading').hover(); await details.hover();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await f.page.getByRole('tooltip').count(), 0);
      } finally { await f.close(); }
    });

    await t.test('long failure logs remain scrollable inside the desktop hover panel', async () => {
      for (const viewport of [{ width: 1280, height: 900 }]) {
        const f = await fixture(true, viewport);
        try {
          f.state.detailResponse.logs = Array.from({ length: 10 }, (_, index) => ({ id: `1000-${index}`, time: task.requestedAt,
            level: index === 9 ? 'ERROR' : 'WARNING', message: `记录 ${index + 1}：${'装备材料识别失败，重新截图后重试。'.repeat(10)}` }));
          f.state.detailResponse.truncated = true;
          await f.open('近七天刷日常情况');
          const dialog = f.page.getByRole('dialog', { name: '近七天刷日常情况' });
          await dialog.getByRole('button', { name: 'Sakura_03的失败详情', exact: true }).hover();
          const tooltip = f.page.getByRole('tooltip');
          await tooltip.getByText('相关执行日志', { exact: true }).waitFor();
          const box = await tooltip.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
          assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
          assert.ok(await tooltip.evaluate(el => el.scrollHeight > el.clientHeight));
          await tooltip.hover(); await f.page.mouse.wheel(0, 300);
          await f.page.waitForFunction(() => (document.querySelector('[role="tooltip"]')?.scrollTop ?? 0) > 0, null, { timeout: 2000 });
          assert.equal(await tooltip.isVisible(), true);
        } finally { await f.close(); }
      }
    });

    await t.test('touch browsers show readable task cards and tap-to-open scrollable failure details', async () => {
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
        const f = await fixture(true, viewport, true);
        try {
          f.state.detailResponse.logs = Array.from({ length: 10 }, (_, index) => ({ id: `1000-${index}`, time: task.requestedAt,
            level: index === 9 ? 'ERROR' : 'WARNING', message: `记录 ${index + 1}：${'request_id=long_unbroken_token_'.repeat(12)}` }));
          f.state.detailResponse.truncated = true;
          await f.open('近七天刷日常情况');
          const list = f.page.getByRole('dialog', { name: '近七天刷日常情况', exact: true });
          const trigger = list.getByRole('button', { name: 'Sakura_03的失败详情', exact: true });
          await trigger.waitFor();
          if (viewport.width < 768) {
            assert.equal(await list.getByRole('table').count(), 0);
            const cards = list.getByRole('list', { name: '近七天任务列表' }).getByRole('listitem');
            assert.equal(await cards.count(), 3);
            assert.match(await cards.first().innerText(), /Naruto_01[\s\S]*已完成[\s\S]*申请时间[\s\S]*08:00:00[\s\S]*扫码完成[\s\S]*08:02:00[\s\S]*执行完成[\s\S]*08:30:00/);
          }
          assert.equal(await list.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'task list must not overflow horizontally');
          assert.equal(f.state.adminReads.some(path => path.endsWith('/failure-details')), false);
          await trigger.scrollIntoViewIfNeeded();
          const triggerBox = await trigger.boundingBox();
          assert.ok(triggerBox.height >= 44, 'details trigger must be a touch target');
          if (viewport.width === 390) await f.page.screenshot({ path: path.join(repository, '.data/admin-preview/daily-mobile.png') });
          await trigger.tap();
          const detail = f.page.getByRole('dialog', { name: '失败详情', exact: true });
          await detail.getByText('相关执行日志', { exact: true }).waitFor();
          await detail.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
          assert.equal(await f.page.getByRole('tooltip').count(), 0);
          assert.equal(await detail.getByRole('listitem').count(), 10);
          assert.match(await detail.innerText(), /失败步骤：装备进阶（18\/35）/);
          const box = await detail.boundingBox();
          assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1, 'failure sheet stays within viewport width');
          assert.ok(box.y >= -1 && box.y + box.height <= viewport.height + 1, 'failure sheet stays within viewport height');
          const scroll = detail.getByRole('region', { name: '失败详情与最近日志' });
          assert.equal(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'long tokens wrap without horizontal scrolling');
          assert.equal(await scroll.evaluate(el => el.scrollHeight > el.clientHeight), true);
          const close = detail.getByRole('button', { name: '关闭失败详情' });
          const closeBox = await close.boundingBox();
          assert.ok(closeBox.height >= 44 && closeBox.width >= 44, `close touch target: ${JSON.stringify(closeBox)}`);
          if (viewport.width === 390) await f.page.screenshot({ path: path.join(repository, '.data/admin-preview/failure-mobile.png') });
          const area = await scroll.boundingBox();
          const cdp = await f.context.newCDPSession(f.page);
          const x = area.x + area.width / 2, start = area.y + area.height * 0.8, end = area.y + area.height * 0.2;
          const scrollFinished = scroll.evaluate(el => new Promise(resolve => el.addEventListener('scrollend', () => resolve(true), { once: true })));
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
          for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 8 }],
          });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await f.page.waitForFunction(() => (document.querySelector('[data-slot="failure-details-scroll"]')?.scrollTop ?? 0) > 0);
          await scrollFinished;
          await cdp.detach();
          assert.deepEqual(await close.boundingBox(), closeBox, 'close button stays fixed while logs scroll');
          await close.tap();
          await detail.waitFor({ state: 'hidden' });
          assert.equal(await list.isVisible(), true);
          assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'closing returns focus to the task');
          assert.deepEqual(f.state.mutations, [], 'viewing details must never dispatch tasks or change data');
        } finally { await f.close(); }
      }
    });

    await t.test('mobile details can retry read failures and dismiss safely after permission loss', async () => {
      const f = await fixture(true, { width: 390, height: 844 }, true);
      try {
        f.state.detailStatus = 503;
        await f.open('近七天刷日常情况');
        const list = f.page.getByRole('dialog', { name: '近七天刷日常情况', exact: true });
        await list.getByRole('button', { name: 'Sakura_03的失败详情', exact: true }).tap();
        const detail = f.page.getByRole('dialog', { name: '失败详情', exact: true });
        await detail.getByRole('alert').waitFor();
        f.state.detailStatus = 200;
        await detail.getByRole('button', { name: '重试读取', exact: true }).tap();
        await detail.getByText('相关执行日志', { exact: true }).waitFor();
        assert.equal(await detail.getByRole('listitem').count(), 3);
        await detail.getByRole('button', { name: '关闭失败详情' }).tap();
        await detail.waitFor({ state: 'hidden' });
        f.state.access = false;
        await list.getByRole('button', { name: 'Sakura_03的失败详情', exact: true }).tap();
        await list.waitFor({ state: 'hidden' });
        await detail.waitFor({ state: 'hidden' });
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
