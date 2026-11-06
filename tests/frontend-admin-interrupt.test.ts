import assert from 'node:assert/strict';
import test from 'node:test';
import * as admin from '../src/frontend/lib/admin.js';
import { dailyStatusLabels } from '../src/shared/admin.js';

const taskId = '20000000-0000-4000-8000-000000000001';

test('仅执行中的六种状态允许管理员中断，排队和终态不显示入口', () => {
  const active = new Set(['starting_emulator', 'opening_game', 'preparing_qr', 'waiting_scan', 'finishing_login', 'running_daily']);
  for (const status of Object.keys(dailyStatusLabels) as Array<keyof typeof dailyStatusLabels>) {
    assert.equal(admin.canInterruptDailyTask(status), active.has(status), status);
  }
});

test('中断响应必须确认同一任务的UUID及interrupted状态', () => {
  assert.ok(admin.isTaskInterruptResponse({ taskId, status: 'interrupted' }, taskId));
  for (const value of [null, [], 'interrupted', {}, { taskId },
    { taskId, status: 'completed' }, { taskId, status: 'running_daily' },
    { taskId: '20000000-0000-4000-8000-000000000002', status: 'interrupted' },
    { taskId: 123, status: 'interrupted' }]) {
    assert.equal(admin.isTaskInterruptResponse(value, taskId), false);
  }
  assert.equal(admin.isTaskInterruptResponse({ taskId: 'invalid', status: 'interrupted' }, 'invalid'), false);
});

test('中断POST沿用管理员请求约定，只发送空JSON对象', async t => {
  const requests: Array<{ path: string; options: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    requests.push({ path, options });
    return Response.json({ taskId, status: 'interrupted' });
  });
  const path = `/api/admin/daily-tasks/${taskId}/interrupt`;

  const response = await admin.adminRequest(path, new AbortController().signal, 'POST');

  assert.deepEqual(response, { taskId, status: 'interrupted' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, path);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.body, '{}');
  assert.equal(new Headers(requests[0].options.headers).get('Content-Type'), 'application/json');
});

test('原有带数据的管理员请求继续发送JSON', async t => {
  let options: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_path: string, request: RequestInit) => {
    options = request;
    return Response.json({ user: {} });
  });
  const fields = { username: 'Naruto', isAdmin: false };

  await admin.adminRequest('/api/admin/users', new AbortController().signal, 'POST', fields);

  assert.equal(options?.body, JSON.stringify(fields));
  assert.equal(new Headers(options?.headers).get('Content-Type'), 'application/json');
});
