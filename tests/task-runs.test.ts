import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoginEvent } from '../src/server/database.js';
import { TaskRunService, isStreamCursor, type RunRedisDriver } from '../src/server/task-runs.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const owner = '456e7890-e89b-42d3-a456-426614174000';
const at = '2026-09-24T01:00:00.000Z';
const event: LoginEvent = { id, userId: owner, requestId: id, status: 'qr_ready', accessToken: 'ab'.repeat(32),
  createdAt: at, expiresAt: '2026-09-24T01:02:00.000Z', dispatchedAt: at, finishedAt: null };
const run = { taskId: id, status: 'running_daily', updatedAt: at, startedAt: at, finishedAt: null,
  actionIndex: 2, actionTotal: 38, workerId: 'private-worker', sequence: 10, accessToken: 'private-token' };
const log = (sequence: number, payload: unknown = { time: at, level: 'INFO', message: `完成步骤 ${sequence}` }) =>
  [`1800000000000-${sequence}`, ['json', JSON.stringify(payload)]];

function fixture() {
  const config = { redisUrl: 'redis://fixture', redisQueueKey: 'naruto:login:tasks', timeoutMs: 100 };
  const records = new Map([[id, event]]);
  let snapshot: unknown = [JSON.stringify(run), [log(1)], '1800000000000-1', 1, 1];
  let calls = 0, connections = 0, destroyed = 0;
  let ready = false;
  const operations: Array<{ keys: string[]; arguments: string[] }> = [];
  const driver: RunRedisDriver = { get isReady() { return ready; },
    async connect() { ready = true; connections++; },
    async eval(script, options) {
      calls++; operations.push(options);
      assert.match(script, /redis\.call\('XRANGE'/);
      assert.match(script, /redis\.call\('XINFO'/);
      assert.doesNotMatch(script, /redis\.call\('(SET|DEL|XREADGROUP|XDEL|EXPIRE|LPUSH|BRPOP)'/);
      return snapshot;
    },
    destroy() { destroyed++; ready = false; },
  };
  const store = { async initialize() {},
    async getEvent(taskId: string, userId: string) { const e = records.get(taskId); return e?.userId === userId ? e : null; },
    async getLatestForUser(userId: string) {
      return [...records.values()].filter(e => e.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
    },
  };
  const service = new TaskRunService(config, { store, createDriver: () => driver, now: () => Date.parse(at) + 300000 });
  return { service, store, driver, config, records, operations,
    setSnapshot(value: unknown) { snapshot = value; },
    get calls() { return calls; }, get connections() { return connections; }, get destroyed() { return destroyed; } };
}

test('最近任务仅从用户持久记录恢复，二维码过期仍可读取且不访问 Redis 或重新派发', async () => {
  const f = fixture();
  const latest = await f.service.getLatest(owner);
  assert.deepEqual(latest, { task: { id, createdAt: event.createdAt, expiresAt: event.expiresAt, status: 'expired' } });
  assert.deepEqual(await f.service.getLatest('other-user'), { task: null });
  assert.equal(f.calls, 0);
  assert.equal(f.connections, 0);
  assert.doesNotMatch(JSON.stringify(latest), /accessToken|requestId|userId/);
});

test('归属验证在读取 Redis 之前，不存在与他人任务均不暴露数据', async () => {
  const f = fixture();
  await assert.rejects(f.service.getEvents(id, 'other-user'), { status: 404 });
  await assert.rejects(f.service.getEvents('123e4567-e89b-42d3-a456-426614174001', owner), { status: 404 });
  assert.equal(f.calls, 0);
  assert.equal(f.connections, 0);
});

test('二维码到期后继续读日常阶段，读取幂等且白名单过滤内部运行字段', async () => {
  const f = fixture();
  f.setSnapshot([JSON.stringify(run), [log(1, { time: at, level: 'INFO', message: '完成组织祈福',
    actionIndex: 2, actionTotal: 38, accessToken: 'secret' })], '1800000000000-1', 1, 1]);
  const result = await f.service.getEvents(id, owner);
  assert.deepEqual(await f.service.getEvents(id, owner), result);
  assert.equal(result.task.status, 'expired');
  assert.equal(result.run?.status, 'running_daily');
  assert.equal(result.logs[0].message, '完成组织祈福');
  assert.equal(result.logs[0].actionIndex, 2);
  assert.equal(result.nextCursor, '1800000000000-1');
  assert.equal(result.hasMore, false);
  assert.equal(result.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /accessToken|requestId|userId|workerId|sequence|secret/);
  assert.equal(f.connections, 1);
  assert.deepEqual(f.operations[0], { keys: [`naruto:login:tasks:runs:${id}`, `naruto:login:tasks:logs:${id}`], arguments: ['0-0', '101'] });
  f.service.close();
  assert.equal(f.destroyed, 1);
});

test('按排他游标最多返回100条，多页保留最后读取位置而不消费日志', async () => {
  const f = fixture();
  f.setSnapshot([JSON.stringify({ ...run, status: 'completed', finishedAt: at }),
    Array.from({ length: 101 }, (_, i) => log(i + 1)), '1800000000000-1', 150, 150]);
  const first = await f.service.getEvents(id, owner);
  assert.equal(first.logs.length, 100);
  assert.equal(first.nextCursor, '1800000000000-100');
  assert.equal(first.hasMore, true);
  assert.equal(first.run?.status, 'completed');
  f.setSnapshot([JSON.stringify(run), Array.from({ length: 50 }, (_, i) => log(i + 101)), '1800000000000-1', 150, 150]);
  const second = await f.service.getEvents(id, owner, first.nextCursor);
  assert.equal(second.logs.length, 50);
  assert.equal(second.logs[0].id, '1800000000000-101');
  assert.equal(second.nextCursor, '1800000000000-150');
  assert.equal(second.hasMore, false);
  assert.equal(second.truncated, false);
  assert.deepEqual(f.operations[1].arguments, [first.nextCursor, '101']);
});

test('日志裁剪通知新读者与游标落后的重连读者，正常续读不误报', async () => {
  const f = fixture();
  f.setSnapshot([JSON.stringify(run), [log(50)], '1800000000000-50', 100, 51]);
  assert.equal((await f.service.getEvents(id, owner)).truncated, true);
  assert.equal((await f.service.getEvents(id, owner, '1800000000000-10')).truncated, true);
  f.setSnapshot([JSON.stringify(run), [log(51)], '1800000000000-50', 100, 51]);
  assert.equal((await f.service.getEvents(id, owner, '1800000000000-50')).truncated, false);
});

test('尚未执行或运行记录过期时返回空结果并保留游标', async () => {
  const f = fixture();
  f.setSnapshot([null, [], '', 0, 0]);
  const result = await f.service.getEvents(id, owner, '1800000000000-42');
  assert.equal(result.run, null);
  assert.deepEqual(result.logs, []);
  assert.equal(result.nextCursor, '1800000000000-42');
  assert.equal(result.hasMore, false);
  assert.equal(result.truncated, false);
});

test('严格验证 UUID 和 Redis uint64 游标，拒绝数组、范围符号与超长数字', async () => {
  const f = fixture();
  for (const cursor of ['', '1', '-1-0', '1-01', '(1-0', '+', '18446744073709551616-0', '0-18446744073709551616', '1-0\n']) {
    assert.equal(isStreamCursor(cursor), false, cursor);
    await assert.rejects(f.service.getEvents(id, owner, cursor), { status: 400 });
  }
  assert.equal(isStreamCursor(['0-0']), false);
  assert.equal(isStreamCursor('18446744073709551615-18446744073709551615'), true);
  await assert.rejects(f.service.getEvents('../another', owner), { status: 400 });
  assert.equal(f.calls, 0);
});

test('坏日志被略过并推进游标，不回传未知字段，坏运行快照只返回固定错误', async () => {
  const f = fixture();
  f.setSnapshot([JSON.stringify(run), [log(1, { message: 'secret' }), log(2, { time: at, level: 'INFO', message: 'x'.repeat(1001) }), log(3)],
    '1800000000000-1', 3, 3]);
  const result = await f.service.getEvents(id, owner);
  assert.equal(result.logs.length, 1);
  assert.equal(result.nextCursor, '1800000000000-3');
  assert.equal(result.truncated, true);
  for (const invalid of ['secret:not-json', JSON.stringify({ ...run, taskId: 'other' }), JSON.stringify({ ...run, errorCode: 'redis://secret' })]) {
    f.setSnapshot([invalid, [], '', 0, 0]);
    await assert.rejects(f.service.getEvents(id, owner), error => {
      assert.equal((error as { code: string }).code, 'TASK_RUN_DATA_INVALID');
      assert.doesNotMatch(String(error), /secret|redis:\/\//); return true;
    });
  }
});

test('Redis 错误与数据库错误脱敏，失败连接会释放且后续允许重建', async () => {
  const f = fixture();
  const evaluate = f.driver.eval;
  f.driver.eval = async () => { throw new Error('redis://private-password@host'); };
  await assert.rejects(f.service.getEvents(id, owner), error => {
    assert.equal((error as { code: string }).code, 'TASK_LOGS_UNAVAILABLE');
    assert.doesNotMatch(String(error), /private-password|host/); return true;
  });
  assert.equal(f.destroyed, 1);
  f.driver.eval = evaluate;
  assert.equal((await f.service.getEvents(id, owner)).logs.length, 1);
  assert.equal(f.connections, 2);
  f.store.getLatestForUser = async () => { throw new Error('postgresql://private-password@host'); };
  await assert.rejects(f.service.getLatest(owner), error => {
    assert.equal((error as { code: string }).code, 'TASK_RUNS_UNAVAILABLE');
    assert.doesNotMatch(String(error), /private-password|host/); return true;
  });
});

test('进度字段必须成对且索引不超过总数，日志长度按 Unicode 字符计数兼容 Python', async () => {
  const f = fixture();
  const malformed = [{ actionIndex: 1 }, { actionTotal: 2 }, { actionIndex: 3, actionTotal: 2 },
    { actionIndex: 0, actionTotal: 100001 }, { actionIndex: true, actionTotal: 2 }];
  for (const value of malformed) {
    f.setSnapshot([JSON.stringify({ ...run, actionIndex: undefined, actionTotal: undefined, ...value }), [], '', 0, 0]);
    await assert.rejects(f.service.getEvents(id, owner), { code: 'TASK_RUN_DATA_INVALID' });
  }
  const entries = malformed.map((value, i) => log(i + 1, { time: at, level: 'INFO', message: '完成步骤', ...value }));
  entries.push(log(6, { time: at, level: 'INFO', message: '😀'.repeat(1000), actionIndex: 2, actionTotal: 2 }));
  entries.push(log(7, { time: at, level: 'INFO', message: '😀'.repeat(1001) }));
  f.setSnapshot([JSON.stringify(run), entries, '1800000000000-1', 7, 7]);
  const result = await f.service.getEvents(id, owner);
  assert.equal(result.logs.length, 1);
  assert.equal([...result.logs[0].message].length, 1000);
  assert.equal(result.logs[0].actionIndex, 2);
  assert.equal(result.nextCursor, '1800000000000-7');
  assert.equal(result.truncated, true);
  f.setSnapshot([JSON.stringify(run), [['1800000000000-8', ['json',
    `{"time":"${at}","level":"INFO","message":"${'\\ud83d\\ude00'.repeat(1000)}"}`]]], '1800000000000-8', 1, 1]);
  assert.equal([...(await f.service.getEvents(id, owner)).logs[0].message].length, 1000);
});

test('未配置 Redis 不影响数据库恢复，超时中止读取并释放连接', async () => {
  const f = fixture();
  const missing = new TaskRunService({ ...f.config, redisUrl: undefined }, { store: f.store });
  assert.equal((await missing.getLatest(owner)).task?.id, id);
  await assert.rejects(missing.getEvents(id, owner), { code: 'REDIS_NOT_CONFIGURED' });
  let signal: AbortSignal | undefined;
  f.driver.eval = async (_script, _options, current) => { signal = current; return await new Promise(() => {}); };
  const slow = new TaskRunService({ ...f.config, timeoutMs: 10 }, { store: f.store, createDriver: () => f.driver });
  await assert.rejects(slow.getEvents(id, owner), { code: 'TASK_LOGS_UNAVAILABLE' });
  assert.equal(signal?.aborted, true);
  assert.equal(f.destroyed, 1);
});

test('失败任务到二维码有效期后仍保留失败状态与独立运行错误码', async () => {
  const f = fixture();
  f.records.set(id, { ...event, status: 'failed' });
  f.setSnapshot([JSON.stringify({ ...run, status: 'failed', finishedAt: at, errorCode: 'worker_clock_skew' }), [], '', 0, 0]);
  assert.equal((await f.service.getLatest(owner)).task?.status, 'failed');
  const result = await f.service.getEvents(id, owner);
  assert.equal(result.task.status, 'failed');
  assert.equal(result.run?.errorCode, 'worker_clock_skew');
  assert.deepEqual(result.logs, []);
});
