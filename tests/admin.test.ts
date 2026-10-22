import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdminService } from '../src/server/admin.js';
import { ApiError } from '../src/server/errors.js';
import { UserManagementError, UsernameTakenError, type AdminStore, type DailyEvent, type StoredUser } from '../src/server/database.js';
import type { User } from '../src/server/auth.js';
import type { TaskRun } from '../src/server/task-runs.js';
import type { ManagedUser } from '../src/shared/admin.js';
import * as adminTypes from '../src/shared/admin.js';
import type { UserOptions } from '../src/shared/user-options.js';

const admin: User = { id: '10000000-0000-4000-8000-000000000001', username: 'Admin', isAdmin: true };
const id = '10000000-0000-4000-8000-000000000002';
const now = Date.parse('2026-10-08T16:00:00.000Z'); // Beijing midnight, October 9.
const user: ManagedUser = { id, username: 'Naruto', isAdmin: false, isInvalid: false, createdAt: new Date(now).toISOString(), applicationStatus: null };
const fail = async (): Promise<never> => assert.fail('unexpected store call');
function fixture(overrides: Partial<AdminStore> = {}, runs: Array<TaskRun | null> = [], clock = now) {
  const calls: unknown[][] = [];
  const store: AdminStore = { initialize: async () => {}, listUsers: fail, getManagedUser: fail, createUser: fail,
    updateUser: fail, deleteUser: fail, listDailyEvents: fail, listMonthlyStats: fail, ...overrides };
  const service = new AdminService({ store, now: () => clock, runs: {
    getSummaries: async ids => { calls.push(ids); return runs; }, getFailureDetails: fail, getAdminLogPage: fail, interrupt: fail,
  } });
  return { service, store, calls };
}
const errorIs = (status: number, code: string) => (error: unknown) => {
  assert.ok(error instanceof ApiError); assert.equal(error.status, status); assert.equal(error.code, code); return true;
};

test('all administrator methods reject ordinary accounts before touching storage', async () => {
  const { service } = fixture({ initialize: fail });
  const normal = { ...admin, isAdmin: false };
  for (const operation of [() => service.listUsers(normal, {}), () => service.getUser(normal, id),
    () => service.createUser(normal, {}), () => service.updateUser(normal, id, {}), () => service.deleteUser(normal, id),
    () => service.dailyTasks(normal, {}), () => service.monthlyStats(normal, {}), () => service.dailyTaskFailureDetails(normal, id),
    () => service.dailyTaskLogs(normal, id), () => service.interruptDailyTask(normal, id)]) await assert.rejects(operation(), errorIs(403, 'ADMIN_REQUIRED'));
});

test('administrator failure details read the requested task without dispatching jobs or querying a user-owned event', async () => {
  const details = { taskId: id, errorCode: 'daily_failed', errorMessage: '具体错误：未找到挑战按钮', logs: [], truncated: false };
  const service = new AdminService({ runs: { getSummaries: fail, getAdminLogPage: fail, interrupt: fail, getFailureDetails: async taskId => {
    assert.equal(taskId, id); return details;
  } } });
  assert.deepEqual(await service.dailyTaskFailureDetails(admin, id), details);
});

test('administrator log pages forward the snapshot and cursor without owner lookup or summary reads', async () => {
  const page = { taskId: id, status: 'completed' as const, logs: [], nextCursor: '1-1',
    snapshotCursor: '1-2', hasMore: true, truncated: false };
  const calls: unknown[][] = [];
  const service = new AdminService({ runs: { getSummaries: fail, getFailureDetails: fail, interrupt: fail,
    getAdminLogPage: async (...args) => { calls.push(args); return page; } } });
  assert.deepEqual(await service.dailyTaskLogs(admin, id), page);
  assert.deepEqual(await service.dailyTaskLogs(admin, id, '1-1', '1-2'), page);
  assert.deepEqual(calls, [[id, '0-0', undefined], [id, '1-1', '1-2']]);
});

test('user search is validated, trimmed and paginated without silently dropping users', async () => {
  const f = fixture({ listUsers: async (search, offset, limit) => {
    assert.equal(search, 'Naru_to'); assert.equal(offset, 20); assert.equal(limit, 20); return { items: [user], total: 41 };
  } });
  assert.deepEqual(await f.service.listUsers(admin, { search: ' Naru_to ', page: '2' }), { items: [user], total: 41, page: 2, pageSize: 20 });
  for (const page of ['0', '-1', '1.1', '01', '1000000', ['1', '2']]) await assert.rejects(f.service.listUsers(admin, { page }), errorIs(400, 'INVALID_PAGE'));
  for (const search of [['x'], 'x'.repeat(101)]) await assert.rejects(f.service.listUsers(admin, { search }), errorIs(400, 'INVALID_SEARCH'));
});

test('用户状态按是否启用及最新申请互斥分类，启用优先于申请审核状态', () => {
  assert.deepEqual(adminTypes.userStatusLabels, { enabled: '已启用', pending: '待审核', rejected: '已拒绝', disabled: '已停用' });
  const cases = [
    { isInvalid: false, applicationStatus: null, expected: 'enabled' },
    { isInvalid: false, applicationStatus: 'approved', expected: 'enabled' },
    { isInvalid: false, applicationStatus: 'pending', expected: 'enabled' },
    { isInvalid: false, applicationStatus: 'rejected', expected: 'enabled' },
    { isInvalid: true, applicationStatus: 'pending', expected: 'pending' },
    { isInvalid: true, applicationStatus: 'rejected', expected: 'rejected' },
    { isInvalid: true, applicationStatus: null, expected: 'disabled' },
    { isInvalid: true, applicationStatus: 'approved', expected: 'disabled' },
  ] as const;
  for (const { expected, ...value } of cases) assert.equal(adminTypes.getUserStatus(value), expected);
});

test('用户状态筛选与搜索分页一同传入存储，旧客户端缺省查看全部', async () => {
  for (const status of [undefined, 'all', 'enabled', 'pending', 'rejected', 'disabled'] as const) {
    const f = fixture({ listUsers: async (search, offset, limit, selectedStatus) => {
      assert.equal(search, '群友_小明');
      assert.equal(offset, 40); assert.equal(limit, 20);
      assert.equal(selectedStatus, status ?? 'all');
      return { items: [user], total: 41 };
    } });
    assert.deepEqual(await f.service.listUsers(admin, { search: ' 群友_小明 ', page: '3', status }),
      { items: [user], total: 41, page: 3, pageSize: 20 });
  }
});

test('用户状态筛选拒绝非法值，权限和参数校验均先于数据库访问', async () => {
  const f = fixture({ initialize: fail });
  for (const status of ['', 'approved', 'active', 'ALL', ' enabled ', "pending' OR 1=1", null, true, 0, ['all'], { status: 'all' }]) {
    await assert.rejects(f.service.listUsers(admin, { status }), errorIs(400, 'INVALID_USER_STATUS'));
  }
  await assert.rejects(f.service.listUsers({ ...admin, isAdmin: false }, { status: 'enabled' }), errorIs(403, 'ADMIN_REQUIRED'));
});

test('管理员可按一百个 Unicode 字符的备注搜索，去掉两侧空白并保留分页', async () => {
  const search = '😀'.repeat(100);
  const f = fixture({ listUsers: async (value, offset, limit) => {
    assert.equal(value, search); assert.equal(offset, 20); assert.equal(limit, 20);
    return { items: [user], total: 1 };
  } });
  const result = await f.service.listUsers(admin, { search: `  ${search}  `, page: '2' });
  assert.equal(result.items[0].username, user.username);
  await assert.rejects(f.service.listUsers(admin, { search: search + '😀' }), errorIs(400, 'INVALID_SEARCH'));
});

test('管理员新增备注默认空白，编辑省略保留，显式空白清空，备注不替换用户名', async () => {
  const writes: Array<{ username: string; usernameKey: string; note?: string }> = [];
  const f = fixture({ createUser: async (_actor, input) => { writes.push(input); return { ...user, note: input.note }; },
    updateUser: async (_actor, _target, input) => { writes.push(input); return { ...user, note: input.note }; } });
  const input = { username: ' Naruto ', password: 'fixture-password', isAdmin: false, isInvalid: false };
  await f.service.createUser(admin, input);
  await f.service.createUser(admin, { ...input, note: '  群友 小明 😀  ' });
  await f.service.updateUser(admin, id, input);
  await f.service.updateUser(admin, id, { ...input, note: ' \t ' });
  await f.service.updateUser(admin, id, { ...input, note: '😀'.repeat(100) });
  assert.deepEqual(writes.map(value => value.note), ['', '群友 小明 😀', undefined, '', '😀'.repeat(100)]);
  assert.equal(Object.hasOwn(writes[2], 'note'), false, '旧客户端没有传备注时不能清空');
  assert.ok(writes.every(value => value.username === 'Naruto' && value.usernameKey === 'naruto'));
});

test('非法备注在写数据库前返回明确错误，普通用户没有备注编辑权限', async () => {
  const f = fixture({ initialize: fail });
  const input = { username: 'Naruto', password: 'fixture-password', isAdmin: false, isInvalid: false };
  for (const note of [null, 1, true, [], {}, '汉'.repeat(101), '😀'.repeat(101)]) {
    await assert.rejects(f.service.createUser(admin, { ...input, note }), errorIs(400, 'INVALID_USER_NOTE'));
    await assert.rejects(f.service.updateUser(admin, id, { ...input, note }), errorIs(400, 'INVALID_USER_NOTE'));
  }
  const ordinary = { ...admin, isAdmin: false };
  await assert.rejects(f.service.updateUser(ordinary, id, { ...input, note: '越权编辑' }), errorIs(403, 'ADMIN_REQUIRED'));
});

test('create and edit validate account information; empty edit password preserves the stored password', async () => {
  let created: StoredUser | undefined;
  const f = fixture({ createUser: async (actor, value, time) => {
    assert.equal(actor, admin.id); assert.equal(time.getTime(), now); created = value;
    return { ...user, id: value.id, username: value.username, isAdmin: value.isAdmin, isInvalid: value.isInvalid };
  }, updateUser: async (actor, target, changes) => {
    assert.equal(actor, admin.id); assert.equal(target, id); assert.equal(changes.usernameKey, 'naruto_2');
    assert.equal(Object.hasOwn(changes, 'password'), false); return { ...user, username: changes.username };
  }, getManagedUser: async target => target === id ? user : null });
  const result = await f.service.createUser(admin, { username: ' New_User ', password: 'secret-fixture', isAdmin: true, isInvalid: false, id });
  assert.equal(created?.usernameKey, 'new_user'); assert.equal(created?.password, 'secret-fixture'); assert.notEqual(created?.id, id);
  assert.equal(result.user.isAdmin, true); assert.doesNotMatch(JSON.stringify(result), /password|secret-fixture/);
  assert.deepEqual(await f.service.updateUser(admin, id, { username: 'Naruto_2', password: '', isAdmin: false, isInvalid: false }), { user: { ...user, username: 'Naruto_2' } });
  assert.deepEqual(await f.service.getUser(admin, id), { user });
  await assert.rejects(f.service.getUser(admin, admin.id), errorIs(404, 'USER_NOT_FOUND'));
  for (const body of [{ username: 'ok', password: 'password', isAdmin: false, isInvalid: false },
    { username: 'Naruto', password: 'short', isAdmin: false, isInvalid: false },
    { username: 'Naruto', password: 'password', isAdmin: 'true', isInvalid: false },
    { username: 'Naruto', password: 'password', isAdmin: false, isInvalid: 0 }]) {
    await assert.rejects(f.service.createUser(admin, body), error => error instanceof ApiError && error.status === 400);
  }
  await assert.rejects(f.service.createUser(admin, { username: 'Naruto', password: '', isAdmin: false, isInvalid: false }), errorIs(400, 'INVALID_PASSWORD'));
  await assert.rejects(f.service.updateUser(admin, 'invalid', {}), errorIs(400, 'INVALID_USER_ID'));
});

test('self deletion, disabling and demotion are blocked; store conflicts and errors are sanitized', async () => {
  const f = fixture();
  await assert.rejects(f.service.deleteUser(admin, admin.id), errorIs(409, 'USER_SELF_PROTECTED'));
  for (const flags of [{ isAdmin: false, isInvalid: false }, { isAdmin: true, isInvalid: true }])
    await assert.rejects(f.service.updateUser(admin, admin.id, { username: 'Admin', ...flags }), errorIs(409, 'USER_SELF_PROTECTED'));
  const input = { username: 'Naruto', password: 'password', isAdmin: false, isInvalid: false };
  for (const [error, status, code] of [[new UsernameTakenError(), 409, 'USERNAME_TAKEN'],
    [new UserManagementError('ADMIN_REQUIRED'), 403, 'ADMIN_REQUIRED'], [new UserManagementError('NOT_FOUND'), 404, 'USER_NOT_FOUND'],
    [new UserManagementError('SELF_PROTECTED'), 409, 'USER_SELF_PROTECTED'], [new Error('private-password-database-url'), 503, 'ADMIN_UNAVAILABLE']] as const) {
    const { service } = fixture({ createUser: async () => { throw error; } });
    await assert.rejects(service.createUser(admin, input), caught => {
      assert.ok(caught instanceof ApiError); assert.equal(caught.status, status); assert.equal(caught.code, code);
      assert.doesNotMatch(caught.message, /private-password-database-url/); return true;
    });
  }
});

test('recent history includes today and six previous Beijing dates with an exclusive upper bound', async () => {
  const event: DailyEvent = { id, username: user.username, createdAt: '2026-10-08T16:00:00.000Z', expiresAt: '2026-10-08T16:05:00.000Z', status: 'qr_ready' };
  const run: TaskRun = { taskId: id, status: 'completed', updatedAt: '2026-10-08T16:30:00.000Z',
    authorizedAt: '2026-10-08T16:02:00.000Z', startedAt: '2026-10-08T16:03:00.000Z', finishedAt: '2026-10-08T16:30:00.000Z' };
  const f = fixture({ listDailyEvents: async (start, end, offset, limit) => {
    assert.equal(start.toISOString(), '2026-10-02T16:00:00.000Z'); assert.equal(end.toISOString(), '2026-10-09T16:00:00.000Z');
    assert.equal(offset, 20); assert.equal(limit, 20); return { items: [event], total: 21 };
  } }, [run]);
  assert.deepEqual(await f.service.dailyTasks(admin, { page: '2' }), {
    items: [{ id, username: user.username, note: '', requestedAt: event.createdAt, scannedAt: run.authorizedAt,
      completedAt: run.finishedAt, status: 'completed', loginType: 'android_qq', mainTask: 'daily' }], total: 21, page: 2, pageSize: 20, date: '2026-10-09', startDate: '2026-10-03', mainTask: 'daily', timeZone: 'Asia/Shanghai',
  });
  assert.deepEqual(f.calls, [[id]]);
  const beforeMidnight = fixture({ listDailyEvents: async (start, end) => {
    assert.equal(start.toISOString(), '2026-10-01T16:00:00.000Z'); assert.equal(end.toISOString(), '2026-10-08T16:00:00.000Z'); return { items: [], total: 0 };
  } }, [], now - 1);
  assert.equal((await beforeMidnight.service.dailyTasks(admin, {})).date, '2026-10-08');
});

test('日常列表显示申请保存的渠道，历史缺失值默认安卓 QQ', async () => {
  const channels = ['android_qq', 'ios_qq', 'android_wechat', 'ios_wechat', undefined] as const;
  const items: DailyEvent[] = channels.map((loginType, index) => ({ id: `${id}-${index}`, username: user.username,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), status: 'queued', loginType }));
  const f = fixture({ listDailyEvents: async () => ({ items, total: items.length }) });
  assert.deepEqual((await f.service.dailyTasks(admin, {})).items.map(task => task.loginType),
    ['android_qq', 'ios_qq', 'android_wechat', 'ios_wechat', 'android_qq']);
});

test('扫码列表返回账号当前备注，旧记录没有备注时返回空字符串', async () => {
  const events: DailyEvent[] = ['', '群友 小明'].map((note, index) => ({ id: `${id}-${index}`, username: user.username,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString(), status: 'queued',
    ...(note ? { note } : {}) }));
  const f = fixture({ listDailyEvents: async () => ({ items: events, total: events.length }) });
  const result = await f.service.dailyTasks(admin, {});
  assert.deepEqual(result.items.map(item => item.note), ['', '群友 小明']);
  assert.ok(result.items.every(item => item.username === user.username));
});

test('近七天扫码列表按选定主任务分页，缺省日常并返回每条申请的任务类型', async () => {
  for (const selected of [undefined, 'daily', 'arena_weekly'] as const) {
    const mainTask = selected ?? 'daily';
    const event: DailyEvent = { id, username: user.username, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), status: 'queued',
      ...(selected ? { userOptions: { mainTask: selected, equipmentStamina: true, secretRealmMode: 'all' } } : {}) };
    const f = fixture({ listDailyEvents: async (start, end, offset, limit, selectedTask) => {
      assert.equal(selectedTask, mainTask);
      assert.equal(start.toISOString(), '2026-10-08T16:00:00.000Z');
      assert.equal(end.toISOString(), '2026-10-09T16:00:00.000Z');
      assert.equal(offset, 20); assert.equal(limit, 20);
      return { items: [event], total: 21 };
    } });
    const result = await f.service.dailyTasks(admin, { date: '2026-10-09', page: '2', mainTask: selected });
    assert.equal(result.mainTask, mainTask);
    assert.equal(result.items[0].mainTask, mainTask);
    assert.equal(result.page, 2); assert.equal(result.total, 21);
    assert.equal(result.selectedDate, '2026-10-09');
  }
});

test('近七天扫码列表在访问数据库前拒绝非法任务类型', async () => {
  const f = fixture({ initialize: fail });
  for (const mainTask of ['', 'all', 'arena', 'DAILY', "daily' OR 1=1", ['daily'], ['daily', 'arena_weekly'], { mainTask: 'daily' }, 0, null]) {
    await assert.rejects(f.service.dailyTasks(admin, { mainTask }), errorIs(400, 'INVALID_MAIN_TASK'));
  }
});

test('周胜筛选保留真实失败和完成状态，不套用首次秘境完成规则', async () => {
  const events: DailyEvent[] = ['failed', 'completed'].map((_, index) => ({ id: `${id}-${index}`, username: user.username,
    createdAt: new Date(now - 5000).toISOString(), expiresAt: new Date(now - 1000).toISOString(), status: 'failed',
    userOptions: { mainTask: 'arena_weekly', equipmentStamina: true, secretRealmMode: 'all' } }));
  const runs: TaskRun[] = (['failed', 'completed'] as const).map((status, index) => ({ taskId: events[index].id,
    status, errorCode: status === 'failed' ? 'arena_weekly_failed' : undefined, updatedAt: new Date(now).toISOString(),
    startedAt: new Date(now - 4000).toISOString(), secretRealmCompletedAt: new Date(now - 2000).toISOString(),
    finishedAt: new Date(now).toISOString() }));
  const f = fixture({ listDailyEvents: async () => ({ items: events, total: events.length }) }, runs);
  const result = await f.service.dailyTasks(admin, { mainTask: 'arena_weekly' });
  assert.equal(result.mainTask, 'arena_weekly');
  assert.deepEqual(result.items.map(item => item.mainTask), ['arena_weekly', 'arena_weekly']);
  assert.deepEqual(result.items.map(item => item.status), ['failed', 'completed']);
  assert.deepEqual(result.items.map(item => item.completedAt), [null, runs[1].finishedAt]);
  assert.equal(result.items[0].errorCode, 'arena_weekly_failed');
});

test('daily date filters use one Beijing day and retain pagination across calendar boundaries', async () => {
  for (const [clock, selectedDate, startAt, endAt, earliest] of [
    [now, '2026-10-09', '2026-10-08T16:00:00.000Z', '2026-10-09T16:00:00.000Z', '2026-10-03'],
    [now, '2026-10-03', '2026-10-02T16:00:00.000Z', '2026-10-03T16:00:00.000Z', '2026-10-03'],
    [Date.parse('2024-03-02T00:00:00Z'), '2024-02-29', '2024-02-28T16:00:00.000Z', '2024-02-29T16:00:00.000Z', '2024-02-25'],
    [Date.parse('2027-01-02T00:00:00Z'), '2026-12-31', '2026-12-30T16:00:00.000Z', '2026-12-31T16:00:00.000Z', '2026-12-27'],
  ] as const) {
    const f = fixture({ listDailyEvents: async (start, end, offset, limit) => {
      assert.equal(start.toISOString(), startAt); assert.equal(end.toISOString(), endAt);
      assert.equal(offset, 20); assert.equal(limit, 20);
      return { items: [], total: 21 };
    } }, [], clock);
    const result = await f.service.dailyTasks(admin, { date: selectedDate, page: '2' });
    assert.equal(result.selectedDate, selectedDate); assert.equal(result.startDate, earliest);
    assert.equal(result.page, 2); assert.equal(result.total, 21);
  }
});

test('daily date filters reject invalid and out-of-range dates before accessing storage', async () => {
  const f = fixture({ initialize: fail });
  for (const date of ['2026-10-02', '2026-10-10', '2026-10-9', '2026-13-01', '2026-10-09T00:00:00Z', '', 'all',
    ['2026-10-09'], { date: '2026-10-09' }, 20261009, null]) {
    await assert.rejects(f.service.dailyTasks(admin, { date }), errorIs(400, 'INVALID_DATE'));
  }
  const march = fixture({ initialize: fail }, [], Date.parse('2026-03-02T00:00:00Z'));
  await assert.rejects(march.service.dailyTasks(admin, { date: '2026-02-30' }), errorIs(400, 'INVALID_DATE'));
  const beforeMidnight = fixture({ initialize: fail }, [], now - 1);
  await assert.rejects(beforeMidnight.service.dailyTasks(admin, { date: '2026-10-09' }), errorIs(400, 'INVALID_DATE'));
});

test('QR expiration never overrides an executing script and failed/mock runs do not report script completion', async () => {
  const statuses = ['running_daily', 'failed', 'completed', null] as const;
  const items: DailyEvent[] = statuses.map((_, index) => ({ id: `10000000-0000-4000-8000-00000000000${index + 2}`,
    username: `user${index}`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now - 1000).toISOString(), status: 'expired' }));
  const runs = statuses.map((status, index) => status ? { taskId: items[index].id, status,
    updatedAt: new Date(now).toISOString(), authorizedAt: new Date(now - 5000).toISOString(),
    startedAt: status === 'completed' ? null : new Date(now - 4000).toISOString(), finishedAt: status === 'running_daily' ? null : new Date(now).toISOString() } : null);
  const f = fixture({ listDailyEvents: async () => ({ items, total: 4 }) }, runs);
  const result = await f.service.dailyTasks(admin, {});
  assert.deepEqual(result.items.map(item => item.status), ['running_daily', 'failed', 'completed', 'unavailable']);
  assert.deepEqual(result.items.map(item => item.completedAt), [null, null, null, null]);
  assert.equal(result.items[3].scannedAt, null);
});

test('首次秘境已完成的日常在后续超时、失败、中断或过期后仍显示已完成且保留首次完成时间', async () => {
  const markerAt = new Date(now - 2000).toISOString();
  for (const secretRealmMode of [undefined, 'once', 'all'] as const)
    for (const status of ['failed', 'interrupted', 'expired'] as const)
      for (const errorCode of ['daily_timeout', 'daily_failed']) {
        const event: DailyEvent = { id, username: user.username, createdAt: new Date(now - 5000).toISOString(),
          expiresAt: new Date(now - 1000).toISOString(), status: 'failed',
          ...(secretRealmMode ? { userOptions: { equipmentStamina: true, secretRealmMode } } : {}) };
        const run: TaskRun = { taskId: id, status, errorCode, updatedAt: new Date(now).toISOString(),
          authorizedAt: new Date(now - 4500).toISOString(), startedAt: new Date(now - 4000).toISOString(),
          secretRealmCompletedAt: markerAt, finishedAt: new Date(now).toISOString() };
        const before = JSON.stringify(run);
        const f = fixture({ listDailyEvents: async () => ({ items: [event], total: 1 }) }, [run]);
        const [item] = (await f.service.dailyTasks(admin, {})).items;
        assert.equal(item.status, 'completed');
        assert.equal(item.completedAt, markerAt);
        assert.equal(item.scannedAt, run.authorizedAt);
        assert.equal(Object.hasOwn(item, 'errorCode'), false);
        assert.equal(Object.hasOwn(item, 'errorMessage'), false);
        assert.equal(JSON.stringify(run), before, 'Presentation must not rewrite the worker snapshot');
      }
});

test('管理员日常完成判定不影响运行中任务、无效标记、跳过秘境或周胜任务，完整完成优先', async () => {
  const run: TaskRun = { taskId: id, status: 'failed', errorCode: 'daily_timeout',
    updatedAt: new Date(now).toISOString(), startedAt: new Date(now - 4000).toISOString(),
    secretRealmCompletedAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now).toISOString() };
  const cases: Array<{ run: TaskRun; userOptions?: UserOptions }> = [
    { run: { ...run, status: 'running_daily', finishedAt: null } },
    { run: { ...run, startedAt: null } },
    { run: { ...run, startedAt: 'invalid' } },
    { run: { ...run, secretRealmCompletedAt: undefined } },
    { run: { ...run, secretRealmCompletedAt: 'invalid' } },
    { run, userOptions: { equipmentStamina: true, secretRealmMode: 'skip' } },
    { run, userOptions: { mainTask: 'arena_weekly', equipmentStamina: true, secretRealmMode: 'all' } },
    { run: { ...run, status: 'completed' } },
  ];
  const events: DailyEvent[] = cases.map(({ userOptions }, index) => ({ id: `${id}-${index}`, username: user.username,
    createdAt: new Date(now - 5000).toISOString(), expiresAt: new Date(now - 1000).toISOString(), status: 'failed', userOptions }));
  const runs = cases.map((value, index) => ({ ...value.run, taskId: events[index].id }));
  const f = fixture({ listDailyEvents: async () => ({ items: events, total: events.length }) }, runs);
  const result = await f.service.dailyTasks(admin, {});
  assert.deepEqual(result.items.map(item => item.status), ['running_daily', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'completed']);
  assert.deepEqual(result.items.map(item => item.completedAt), [null, null, null, null, null, null, null, run.finishedAt]);
});

test('daily failures expose each run error with honest fallbacks without adding errors to other statuses', async () => {
  const cases = [
    { status: 'failed', errorCode: 'daily_timeout' },
    { status: 'failed', errorCode: 'emulator_start_failed' },
    { status: 'failed', errorCode: 'future_worker_error' },
    { status: 'failed' },
    null,
    { status: 'completed', errorCode: 'daily_failed' },
    { status: 'running_daily', errorCode: 'daily_failed' },
    { status: 'interrupted', errorCode: 'command_timeout' },
  ] satisfies Array<Pick<TaskRun, 'status' | 'errorCode'> | null>;
  const items: DailyEvent[] = cases.map((_, index) => ({ id: `10000000-0000-4000-8000-0000000000${index + 10}`,
    username: user.username, createdAt: new Date(now).toISOString(), expiresAt: new Date(now - 1000).toISOString(), status: 'failed' }));
  const runs = cases.map((value, index) => value ? { ...value, taskId: items[index].id,
    updatedAt: new Date(now).toISOString(), startedAt: null, finishedAt: null } : null);
  const f = fixture({ listDailyEvents: async () => ({ items, total: items.length }) }, runs);
  const result = await f.service.dailyTasks(admin, {});
  assert.deepEqual(result.items.slice(0, 5).map(({ id, status, errorCode, errorMessage }) => ({ id, status, errorCode, errorMessage })), [
    { id: items[0].id, status: 'failed', errorCode: 'daily_timeout', errorMessage: '日常任务执行超时，请查看执行日志。' },
    { id: items[1].id, status: 'failed', errorCode: 'emulator_start_failed', errorMessage: '模拟器启动失败，请稍后重新申请。' },
    { id: items[2].id, status: 'failed', errorCode: 'future_worker_error', errorMessage: '未记录具体错误原因。' },
    { id: items[3].id, status: 'failed', errorCode: undefined, errorMessage: '未记录具体错误原因。' },
    { id: items[4].id, status: 'failed', errorCode: undefined, errorMessage: '未记录具体错误原因。' },
  ]);
  for (const item of result.items.slice(3, 5)) assert.equal(Object.hasOwn(item, 'errorCode'), false);
  assert.deepEqual(result.items.slice(5).map(item => item.status), ['completed', 'running_daily', 'interrupted']);
  for (const item of result.items.slice(5)) {
    assert.equal(Object.hasOwn(item, 'errorCode'), false);
    assert.equal(Object.hasOwn(item, 'errorMessage'), false);
  }
  assert.deepEqual(f.calls, [items.map(item => item.id)]);
});

test('monthly rankings use Beijing calendar boundaries including leap years and year rollover', async () => {
  for (const [month, startAt, endAt] of [
    ['2026-10', '2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z'],
    ['2024-02', '2024-01-31T16:00:00.000Z', '2024-02-29T16:00:00.000Z'],
    ['2026-12', '2026-11-30T16:00:00.000Z', '2026-12-31T16:00:00.000Z'],
  ]) for (const sort of ['requests', 'days'] as const) {
    const f = fixture({ listMonthlyStats: async (start, end, order, offset, limit) => {
      assert.equal(start.toISOString(), startAt); assert.equal(end.toISOString(), endAt);
      assert.equal(order, sort); assert.equal(offset, 20); assert.equal(limit, 20);
      return { items: [], total: 0, totalRequests: 0 };
    } });
    assert.deepEqual(await f.service.monthlyStats(admin, { month, sort, page: '2' }), {
      items: [], total: 0, totalRequests: 0, month, sort, page: 2, pageSize: 20, timeZone: 'Asia/Shanghai',
    });
    assert.deepEqual(f.calls, [], 'monthly statistics must not depend on expired Redis logs');
  }
  const f = fixture({ listMonthlyStats: async (start) => {
    assert.equal(start.toISOString(), '2026-09-30T16:00:00.000Z'); return { items: [], total: 0, totalRequests: 0 };
  } }, [], Date.parse('2026-09-30T16:00:00Z'));
  assert.equal((await f.service.monthlyStats(admin, {})).month, '2026-10');
});

test('monthly statistics reject malformed filters and sanitize database failures', async () => {
  const f = fixture({ initialize: fail });
  for (const month of ['2026-00', '2026-13', '2026-1', '2026-10-01', '2026-10 OR 1=1', ['2026-10'], 202610, '']) {
    await assert.rejects(f.service.monthlyStats(admin, { month }), errorIs(400, 'INVALID_MONTH'));
  }
  for (const sort of ['rank', 'days DESC', ['days']]) await assert.rejects(f.service.monthlyStats(admin, { sort }), errorIs(400, 'INVALID_SORT'));
  await assert.rejects(f.service.monthlyStats(admin, { page: '0' }), errorIs(400, 'INVALID_PAGE'));
  const broken = fixture({ listMonthlyStats: async () => { throw new Error('private-db-url'); } });
  await assert.rejects(broken.service.monthlyStats(admin, {}), errorIs(503, 'ADMIN_UNAVAILABLE'));
});
