import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskRunService, type RunRedisDriver } from '../src/server/task-runs.js';
import type { TaskLogArchive } from '../src/server/sls-logs.js';
import type { LoginEvent } from '../src/server/database.js';

const taskId = '123e4567-e89b-42d3-a456-426614174000', owner = '456e7890-e89b-42d3-a456-426614174000';
const time = '2026-10-20T08:00:00.000Z';
const event: LoginEvent = { id: taskId, userId: owner, requestId: taskId, status: 'failed', accessToken: 'fixture',
  createdAt: time, expiresAt: time, dispatchedAt: time, finishedAt: time,
  userOptions: { equipmentStamina: true, secretRealmMode: 'all' }, loginType: 'android_qq' };
function fixture(patch: Record<string, unknown> = {}, enabled = true) {
  const run = { taskId, status: 'failed', updatedAt: time, startedAt: time, finishedAt: time,
    logSource: 'sls', logCursor: '100-2', ...patch };
  const scripts: string[] = [];
  let result: Awaited<ReturnType<TaskLogArchive['read']>> = null;
  let error: Error | undefined;
  let reader: TaskLogArchive['read'] | undefined;
  const calls: unknown[][] = [];
  const archive: TaskLogArchive = { async read(...args) { calls.push(args); if (error) throw error; return reader ? reader(...args) : result; } };
  const driver: RunRedisDriver = { isReady: true, async connect() {}, destroy() {}, async eval(script) {
    scripts.push(script);
    if (/return redis.call\('GET', KEYS\[1\]\)/.test(script)) return JSON.stringify(run);
    if (script.includes('return {run, firstId, lastId, exists}')) return [JSON.stringify(run), '', '0-0', 0];
    if (script.includes('local upper')) return [JSON.stringify(run), [], '0-0', '', 0, 0, 0];
    if (script.includes('XINFO')) return [JSON.stringify(run), [], '', 0, 0];
    return [JSON.stringify(run), []];
  } };
  const service = new TaskRunService({ redisUrl: 'redis://fixture', redisQueueKey: 'fixture', timeoutMs: 100 }, {
    ...(enabled ? { archive } : {}), createDriver: () => driver, store: { async initialize() {}, async getLatestForUser() { return event; },
      async getEvent(id, userId) { return id === taskId && userId === owner ? event : null; } },
  });
  return { service, scripts, calls, run, set result(value: typeof result) { result = value; }, set error(value: Error) { error = value; },
    set reader(value: TaskLogArchive['read']) { reader = value; } };
}

test('SLS 新任务日志未入库时实时和管理员详情均明确等待，不能回退空 Redis 后假装结束', async () => {
  for (const logCursor of ['100-2', undefined]) {
    const f = fixture({ logCursor });
    const live = await f.service.getEvents(taskId, owner) as unknown as Record<string, unknown>;
    assert.equal(live.logsPending, true); assert.equal(live.nextCursor, '0-0'); assert.equal(live.hasMore, false);
    const admin = await f.service.getAdminLogPage(taskId) as unknown as Record<string, unknown>;
    assert.equal(admin.logsPending, true); assert.equal(admin.nextCursor, '0-0');
    const failure = await f.service.getFailureDetails(taskId) as unknown as Record<string, unknown>;
    assert.equal(failure.logsPending, true); assert.match(String(failure.errorMessage), /上传|重试/);
    assert(f.scripts.every(script => !/XRANGE|XREVRANGE|XINFO/.test(script)));
  }
});

test('SLS 实时任务直接返回已验证日志和轻量执行状态，其他账号仍在读取前被拒绝', async () => {
  const f = fixture();
  f.result = { logs: [{ id: '100-1', time, level: 'ERROR', message: '具体错误：执行失败' }],
    snapshotCursor: '100-2', nextCursor: '100-2', hasMore: false, truncated: false };
  await assert.rejects(f.service.getEvents(taskId, 'someone-else'), { status: 404 });
  assert.equal(f.scripts.length, 0);
  const live = await f.service.getEvents(taskId, owner);
  assert.equal(live.logs.length, 1);
  assert.equal((live.run as unknown as Record<string, unknown>).logSource, 'sls');
  assert.equal((live as unknown as Record<string, unknown>).logsPending, false);
  assert.equal(live.nextCursor, '100-2');
  assert.equal(f.calls[0][3], '100-2', 'lightweight run watermark is passed to the archive');
});

test('SLS 新任务查询失败或客户端未启用 SLS 时保留读取位置并提示待恢复，不用空 Redis 宣布成功', async () => {
  for (const enabled of [true, false]) {
    const f = fixture({}, enabled); f.error = new Error('fixture provider failure');
    const live = await f.service.getEvents(taskId, owner, '100-1');
    assert.equal(live.logsPending, true); assert.equal(live.nextCursor, '100-1'); assert.equal(live.hasMore, false);
    const page = await f.service.getAdminLogPage(taskId, '100-1');
    assert.equal(page.logsPending, true); assert.equal(page.nextCursor, '100-1'); assert.equal(page.snapshotCursor, '100-2');
    assert.equal((await f.service.getFailureDetails(taskId)).logsPending, true);
  }
});

test('显式关闭日志的任务不查询 SLS，不等待不存在的日志，失败详情说明未记录', async () => {
  const f = fixture({ logSource: 'disabled', logCursor: undefined });
  const live = await f.service.getEvents(taskId, owner);
  assert.equal(live.logsPending, false); assert.equal(live.run?.logSource, 'disabled');
  const page = await f.service.getAdminLogPage(taskId);
  assert.equal(page.logsPending, false); assert.equal(page.hasMore, false);
  const details = await f.service.getFailureDetails(taskId);
  assert.equal(details.logsPending, false); assert.match(details.errorMessage, /未启用/);
  assert.equal(f.calls.length, 0);
});

test('运行中的实时日志展示已入库前缀，终态仍须追上最终水位，管理员始终严格检查', async () => {
  const f = fixture({ status: 'running_daily', logCursor: '100-5' });
  f.reader = async (_id, after, _snapshot, watermark) => {
    if (watermark === '100-5') return null;
    assert.equal(watermark, undefined);
    return { logs: [1, 2, 3].filter(seq => Number(after.split('-')[1]) < seq)
      .map(seq => ({ id: `100-${seq}`, time, level: 'INFO', message: `日志 ${seq}` })),
    nextCursor: '100-3', snapshotCursor: '100-3', hasMore: false, truncated: false };
  };
  const live = await f.service.getEvents(taskId, owner);
  assert.deepEqual(live.logs.map(row => row.id), ['100-1', '100-2', '100-3']);
  assert.equal(live.logsPending, false); assert.equal(live.nextCursor, '100-3');
  const admin = await f.service.getAdminLogPage(taskId);
  assert.equal(admin.logsPending, true); assert.equal(admin.nextCursor, '0-0');
  assert.equal((await f.service.getFailureDetails(taskId)).logsPending, true);
  for (const status of ['completed', 'failed', 'interrupted', 'expired']) {
    f.run.status = status;
    const terminal = await f.service.getEvents(taskId, owner, live.nextCursor);
    assert.equal(terminal.logsPending, true); assert.equal(terminal.nextCursor, '100-3');
    assert.equal(terminal.hasMore, false); assert.deepEqual(terminal.logs, []);
  }
});
