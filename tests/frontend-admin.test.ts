import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDailyPage, isDailyTaskFailureDetails, isUserResponse, isUsersPage, formatAdminDate } from '../src/frontend/lib/admin.js';

const user = { id: 'user', username: 'Naruto', isAdmin: false, isInvalid: false, createdAt: '2026-10-08T16:00:00.000Z', applicationStatus: null };
test('administrator responses validate timestamps, roles, pagination and known task states', () => {
  assert.ok(isUserResponse({ user }));
  assert.ok(isUsersPage({ items: [user], page: 1, pageSize: 20, total: 1 }));
  for (const invalid of [{ ...user, isAdmin: 'true' }, { ...user, isInvalid: 0 }, { ...user, createdAt: 'broken' }, { ...user, applicationStatus: 'active' }])
    assert.equal(isUserResponse({ user: invalid }), false);
  const daily = { items: [{ id: 'task', username: 'Naruto', requestedAt: user.createdAt, scannedAt: null, completedAt: null, status: 'running_daily' }],
    page: 1, pageSize: 20, total: 1, date: '2026-10-09', timeZone: 'Asia/Shanghai' };
  assert.ok(isDailyPage(daily));
  const failed = { ...daily.items[0], status: 'failed', errorCode: 'daily_timeout', errorMessage: '日常任务执行超时。' };
  assert.ok(isDailyPage({ ...daily, items: [failed] }));
  assert.equal(isDailyPage({ ...daily, items: [{ ...failed, errorMessage: {} }] }), false);
  assert.equal(isDailyPage({ ...daily, items: [{ ...failed, errorCode: 'invalid code' }] }), false);
  assert.equal(isDailyPage({ ...daily, items: [{ ...daily.items[0], status: 'unknown' }] }), false);
  assert.equal(isDailyPage({ ...daily, items: [{ ...daily.items[0], completedAt: 'broken' }] }), false);
  assert.equal(isDailyPage({ ...daily, total: -1 }), false);
  assert.equal(isDailyPage({ ...daily, timeZone: 'UTC' }), false);
  assert.equal(formatAdminDate(null), '—');
  assert.match(formatAdminDate(user.createdAt), /2026\D+10\D+09.*00:00:00/);
});

test('failure details validate bounded log history and paired action progress before rendering', () => {
  const details = { taskId: 'task', errorCode: 'daily_failed', errorMessage: '具体错误：VisualError: 无法识别页面',
    actionIndex: 2, actionTotal: 35, actionName: '动作 2/35：装备进阶', truncated: false,
    logs: [{ id: '1000-0', time: user.createdAt, level: 'ERROR', message: '无法识别页面' }] };
  assert.ok(isDailyTaskFailureDetails(details));
  assert.ok(isDailyTaskFailureDetails({ taskId: 'old-task', errorMessage: '未记录具体错误原因。', logs: [], truncated: true }));
  for (const invalid of [{ ...details, errorMessage: {} }, { ...details, actionTotal: undefined },
    { ...details, actionName: 12 }, { ...details, logs: Array(31).fill(details.logs[0]) },
    { ...details, logs: [{ ...details.logs[0], message: 'x'.repeat(1001) }] },
    { ...details, logs: [{ ...details.logs[0], level: 'DEBUG' }] },
    { ...details, logs: [{ ...details.logs[0], time: 'not-a-date' }] }]) assert.equal(isDailyTaskFailureDetails(invalid), false);
});
