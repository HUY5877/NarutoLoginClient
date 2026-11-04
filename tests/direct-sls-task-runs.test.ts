import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskRunService, type RunRedisDriver } from '../src/server/task-runs.js';
import type { TaskLogArchive } from '../src/server/sls-logs.js';
import type { LoginEvent } from '../src/server/database.js';
import { privateTaskMessages } from './private-task-log-fixtures.js';

const taskId = '123e4567-e89b-42d3-a456-426614174000', owner = '456e7890-e89b-42d3-a456-426614174000';
const time = '2026-10-20T08:00:00.000Z';
const event: LoginEvent = { id: taskId, userId: owner, requestId: taskId, status: 'failed', accessToken: 'fixture',
  createdAt: time, expiresAt: time, dispatchedAt: time, finishedAt: time,
  userOptions: { equipmentStamina: true, secretRealmMode: 'all' }, loginType: 'android_qq' };
function fixture(patch: Record<string, unknown> = {}, enabled = true) {
  const run = { taskId, status: 'failed', updatedAt: time, startedAt: time, finishedAt: time,
    logSource: 'sls', logCursor: '100-2', ...patch };
  const scripts: string[] = [];
  let result: Awaited<ReturnType<TaskLogArchive['read']>> = { logs: [], nextCursor: '0-0', hasMore: false, truncated: false };
  let error: Error | undefined;
  let reader: TaskLogArchive['read'] | undefined;
  const calls: unknown[][] = [];
  const archive: TaskLogArchive = { async read(...args) { calls.push(args); if (error) throw error; return reader ? reader(...args) : result; } };
  const driver: RunRedisDriver = { isReady: true, async connect() {}, destroy() {}, async eval(script) {
    scripts.push(script);
    if (/return redis.call\('GET', KEYS\[1\]\)/.test(script)) return JSON.stringify(run);
    if (script.includes('XINFO')) return [JSON.stringify(run), [], '', 0, 0];
    return [JSON.stringify(run), []];
  } };
  const service = new TaskRunService({ redisUrl: 'redis://fixture', redisQueueKey: 'fixture', timeoutMs: 100 }, {
    ...(enabled ? { archive } : {}), createDriver: () => driver, store: { async initialize() {}, async getLatestForUser() { return event; },
      async getEvent(id, userId) { return id === taskId && userId === owner ? event : null; } },
  });
  return { service, scripts, calls, run, driver, set result(value: typeof result) { result = value; }, set error(value: Error) { error = value; },
    set reader(value: TaskLogArchive['read']) { reader = value; } };
}

test('SLS 空响应正常返回且可再刷新，不因缺少Redis日志水位跳过查询', async () => {
  for (const logCursor of ['100-2', undefined, '0-0']) {
    const f = fixture({ logCursor });
    const live = await f.service.getEvents(taskId, owner);
    assert.equal(live.logsPending, false); assert.equal(live.nextCursor, '0-0');
    const admin = await f.service.getAdminLogPage(taskId);
    assert.deepEqual(admin, { taskId, status: 'failed', logs: [], nextCursor: '0-0' });
    const failure = await f.service.getFailureDetails(taskId);
    assert.equal(failure.logsPending, undefined); assert.doesNotMatch(failure.errorMessage, /正在上传/);
    assert.equal(f.calls.length, 3);
    assert(f.scripts.every(script => !/XRANGE|XREVRANGE|XINFO/.test(script)));
  }
});

test('归属检查先于SLS读取，部分正文直接展示且不传最终水位', async () => {
  const f = fixture({ logCursor: undefined });
  f.result = { logs: [{ id: '100-1', time, level: 'ERROR', message: '具体错误：执行失败' }],
    nextCursor: '100-1', hasMore: false, truncated: false };
  await assert.rejects(f.service.getEvents(taskId, 'someone-else'), { status: 404 });
  assert.equal(f.scripts.length, 0);
  for (const status of ['running_daily', 'completed', 'failed', 'interrupted', 'expired']) {
    f.run.status = status;
    const live = await f.service.getEvents(taskId, owner);
    assert.equal(live.logs.length, 1); assert.equal(live.logsPending, false); assert.equal(live.nextCursor, '100-1');
    assert.equal((await f.service.getAdminLogPage(taskId)).logs.length, 1);
  }
  assert(f.calls.every(args => args.length === 3 && args[2] === false));
});

test('归档出口过滤内部错误及动作名，管理员仅返回最小四个字段', async () => {
  const f = fixture({ errorCode: 'login_failed' });
  for (const message of privateTaskMessages) {
    f.result = { logs: [
      { id: '100-2', time, level: 'ERROR', message: `具体错误：${message}` },
      { id: '100-1', time, level: 'INFO', message: `动作 2/38：${message}`, actionIndex: 2, actionTotal: 38 },
    ], nextCursor: '100-2', hasMore: true, truncated: false };
    const live = await f.service.getEvents(taskId, owner);
    assert.deepEqual(live.logs, []); assert.equal(live.nextCursor, '100-2'); assert.equal(live.hasMore, true);
    assert.deepEqual(await f.service.getAdminLogPage(taskId), { taskId, status: 'failed', logs: [], nextCursor: '100-2' });
    const failure = await f.service.getFailureDetails(taskId);
    assert.deepEqual(failure.logs, []); assert.equal(failure.actionName, undefined);
    assert.equal(failure.errorMessage, '未能确认游戏登录成功，请重新申请。');
  }
});

test('SLS读取失败和未配置均明确报读失败，不伪装日志正在上传', async () => {
  for (const enabled of [true, false]) {
    const f = fixture({}, enabled); f.error = new Error('fixture provider secret');
    for (const read of [() => f.service.getEvents(taskId, owner, '100-1'),
      () => f.service.getAdminLogPage(taskId, '100-1'), () => f.service.getFailureDetails(taskId)]) {
      await assert.rejects(read(), error => {
        assert.equal((error as { code: string }).code, 'TASK_LOGS_UNAVAILABLE');
        assert.match(String(error), /读取失败/); assert.doesNotMatch(String(error), /secret|上传/); return true;
      });
    }
  }
});

test('显式关闭日志不查SLS，失败详情说明未记录', async () => {
  const f = fixture({ logSource: 'disabled', logCursor: undefined });
  const live = await f.service.getEvents(taskId, owner);
  assert.equal(live.logsPending, false);
  assert.deepEqual(await f.service.getAdminLogPage(taskId), { taskId, status: 'failed', logs: [], nextCursor: '0-0' });
  assert.match((await f.service.getFailureDetails(taskId)).errorMessage, /未启用/);
  assert.equal(f.calls.length, 0);
});

test('旧任务无日志来源且SLS确实为空时仍读取Redis历史，新SLS任务不回退', async () => {
  const f = fixture({ logSource: undefined, logCursor: undefined });
  const original = f.driver.eval;
  f.driver.eval = async (script, options, signal) => script.includes('XINFO')
    ? [JSON.stringify(f.run), [['100-1', ['json', JSON.stringify({ time, level: 'INFO', message: '旧任务日志' })]]], '100-1', 1, 1]
    : original(script, options, signal);
  const page = await f.service.getAdminLogPage(taskId);
  assert.equal(page.logs[0]?.message, '旧任务日志'); assert.equal(page.nextCursor, '100-1');
  assert.equal(f.calls.length, 1);
  f.result = { logs: [], nextCursor: '100-2', hasMore: true, truncated: false };
  assert.equal((await f.service.getAdminLogPage(taskId)).nextCursor, '100-2', '隐藏页已推进时不能回读旧Redis页');
  f.service.close();
});

test('Redis状态不可用仍能读归档，归档失败不重复等待同一次Redis故障', async () => {
  const f = fixture();
  f.driver.eval = async script => { f.scripts.push(script); throw new Error('fixture redis unavailable'); };
  f.result = { logs: [{ id: '100-1', time, level: 'INFO', message: '归档可读' }], nextCursor: '100-1', hasMore: false, truncated: false };
  assert.equal((await f.service.getAdminLogPage(taskId)).logs[0].message, '归档可读');
  assert.equal(f.scripts.length, 1); assert.equal(f.calls.length, 1);
  f.error = new Error('fixture provider failed');
  await assert.rejects(f.service.getAdminLogPage(taskId), { code: 'TASK_LOGS_UNAVAILABLE' });
  assert.equal(f.scripts.length, 2); assert.equal(f.calls.length, 2);
});

test('已确认旧任务来源时SLS故障回读Redis，显式SLS来源仍报读取失败', async () => {
  for (const logSource of [undefined, 'sls']) {
    const f = fixture({ logSource });
    f.error = new Error('fixture provider failed');
    const original = f.driver.eval;
    const entries = [['100-1', ['json', JSON.stringify({ time, level: 'ERROR', message: '具体错误：旧任务执行失败' })]]];
    f.driver.eval = async (script, options, signal) => script.includes('XINFO')
      ? [JSON.stringify(f.run), entries, '100-1', 1, 1] : script.includes('XREVRANGE')
        ? [JSON.stringify(f.run), entries] : original(script, options, signal);
    for (const read of [() => f.service.getEvents(taskId, owner), () => f.service.getAdminLogPage(taskId),
      () => f.service.getFailureDetails(taskId)]) {
      if (logSource === 'sls') await assert.rejects(read(), { code: 'TASK_LOGS_UNAVAILABLE' });
      else assert.equal((await read()).logs[0].message, '具体错误：旧任务执行失败');
    }
    assert.equal(f.calls.length, 3);
    f.service.close();
  }
});
