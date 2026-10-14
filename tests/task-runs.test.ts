import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoginEvent } from '../src/server/database.js';
import { TaskRunService, isStreamCursor, type RunRedisDriver } from '../src/server/task-runs.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const owner = '456e7890-e89b-42d3-a456-426614174000';
const at = '2026-09-24T01:00:00.000Z';
const event: LoginEvent = { id, userId: owner, requestId: id, status: 'qr_ready', accessToken: 'ab'.repeat(32),
  createdAt: at, expiresAt: '2026-09-24T01:02:00.000Z', dispatchedAt: at, finishedAt: null,
  userOptions: { equipmentStamina: true, secretRealmMode: 'all' }, loginType: 'android_qq' };
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

test('administrator summary reads use one bounded GET batch and omit worker logs and private fields', async () => {
  const f = fixture();
  const otherId = '123e4567-e89b-42d3-a456-426614174001';
  let calls = 0;
  f.driver.eval = async (script, options) => {
    calls++;
    assert.match(script, /redis.call\('GET', key\)/);
    assert.doesNotMatch(script, /XRANGE|XINFO|SET|DEL|LPUSH|BRPOP/);
    assert.deepEqual(options, { keys: [`naruto:login:tasks:runs:${id}`, `naruto:login:tasks:runs:${otherId}`], arguments: [] });
    return [JSON.stringify({ ...run, authorizedAt: at }), null];
  };
  assert.deepEqual(await f.service.getSummaries([]), []); assert.equal(calls, 0);
  const summaries = await f.service.getSummaries([id, otherId]);
  assert.equal(calls, 1); assert.equal(summaries[0]?.status, 'running_daily');
  assert.equal(summaries[0]?.authorizedAt, at); assert.equal(summaries[1], null);
  assert.doesNotMatch(JSON.stringify(summaries), /private-worker|private-token|workerId|sequence|accessToken/);
  await assert.rejects(f.service.getSummaries(['invalid']), { status: 400 });
  await assert.rejects(f.service.getSummaries(Array(101).fill(id)), { status: 400 });
  assert.equal(calls, 1);
  f.driver.eval = async () => [JSON.stringify({ ...run, taskId: otherId }), null];
  await assert.rejects(f.service.getSummaries([id, otherId]), { status: 502 });
  f.service.close();
});

function failureFixture(snapshot: unknown = [null, []]) {
  const f = fixture();
  let calls = 0;
  f.driver.eval = async (script, options) => {
    calls++;
    assert.match(script, /redis\.call\('GET', KEYS\[1\]\)/);
    assert.match(script, /redis\.call\('XREVRANGE', KEYS\[2\], '\+', '-', 'COUNT', ARGV\[1\]\)/);
    assert.doesNotMatch(script, /redis\.call\('(SET|DEL|XREADGROUP|XDEL|EXPIRE|LPUSH|BRPOP)'/);
    assert.deepEqual(options, { keys: [`naruto:login:tasks:runs:${id}`, `naruto:login:tasks:logs:${id}`], arguments: ['11'] });
    return snapshot;
  };
  // Admin-only reads deliberately bypass the owner-specific database access path.
  f.store.initialize = async () => { assert.fail('must not query the database'); };
  return { service: f.service, setSnapshot(value: unknown) { snapshot = value; }, get calls() { return calls; } };
}

test('failure details read a bounded non-consuming tail, preserve chronological context and prefer the specific exception over later boilerplate', async () => {
  const f = failureFixture([JSON.stringify({ ...run, status: 'failed', errorCode: 'daily_failed', finishedAt: at }), [
    log(5, { time: at, level: 'ERROR', message: 'daily: failed (daily_failed)' }),
    log(4, { time: at, level: 'ERROR', message: '执行阶段 daily 失败' }),
    log(3, { time: at, level: 'ERROR', message: '具体错误：VisualError: 未找到挑战按钮', accessToken: 'secret' }),
    log(2, { time: at, level: 'WARNING', message: '挑战按钮补查仍未确认' }),
    log(1, { time: at, level: 'INFO', message: '动作 2/38：秘境探险', actionIndex: 2, actionTotal: 38 }),
  ]]);
  const details = await f.service.getFailureDetails(id);
  assert.equal(details.taskId, id);
  assert.equal(details.errorCode, 'daily_failed');
  assert.equal(details.errorMessage, '具体错误：VisualError: 未找到挑战按钮');
  assert.equal(details.actionIndex, 2); assert.equal(details.actionTotal, 38);
  assert.equal(details.actionName, '秘境探险');
  assert.deepEqual(details.logs.map(entry => entry.id), [1, 2, 3, 4, 5].map(value => `1800000000000-${value}`));
  assert.equal(details.truncated, false);
  assert.doesNotMatch(JSON.stringify(details), /workerId|sequence|accessToken|private-worker|private-token|secret/);
  assert.deepEqual(await f.service.getFailureDetails(id), details);
  assert.equal(f.calls, 2);
  f.service.close();
});

test('failure detail tail returns at most ten valid logs and explicitly marks omitted or corrupt entries', async () => {
  const f = failureFixture([null, Array.from({ length: 11 }, (_, index) => log(11 - index))]);
  const details = await f.service.getFailureDetails(id);
  assert.equal(details.logs.length, 10);
  assert.equal(details.logs[0].id, '1800000000000-2');
  assert.equal(details.logs.at(-1)?.id, '1800000000000-11');
  assert.equal(details.truncated, true);
  f.setSnapshot([null, [log(3, { time: at, level: 'INFO', message: 'x'.repeat(1001) }),
    log(2, { message: 'invalid' }), log(1)]]);
  const partial = await f.service.getFailureDetails(id);
  assert.equal(partial.logs.length, 1); assert.equal(partial.truncated, true);
  f.service.close();
});

test('failure details fall back honestly for legacy generic errors and expired history but use substantive older ERROR messages', async () => {
  const f = failureFixture();
  assert.deepEqual(await f.service.getFailureDetails(id), {
    taskId: id, errorMessage: '未记录具体错误原因，执行日志可能尚未上报或已过期。', logs: [], truncated: false,
  });
  f.setSnapshot([JSON.stringify({ ...run, status: 'failed', errorCode: 'daily_failed' }), [
    log(2, { time: at, level: 'ERROR', message: 'daily: failed (daily_failed)' }),
    log(1, { time: at, level: 'ERROR', message: '执行阶段 daily 失败' }),
  ]]);
  assert.equal((await f.service.getFailureDetails(id)).errorMessage, '日常任务执行失败，请查看执行日志。');
  f.setSnapshot([null, [log(1, { time: at, level: 'ERROR', message: '无法连接模拟器 ADB' })]]);
  assert.equal((await f.service.getFailureDetails(id)).errorMessage, '无法连接模拟器 ADB');
  f.service.close();
});

test('legacy failure details prefer a substantive ERROR over the later Redis terminal and stage summaries', async () => {
  const f = failureFixture([JSON.stringify({ ...run, status: 'failed', errorCode: 'daily_failed' }), [
    log(3, { time: at, level: 'ERROR', message: '日常任务执行失败，本次任务已停止。' }),
    log(2, { time: at, level: 'ERROR', message: '任务执行失败' }),
    log(1, { time: at, level: 'ERROR', message: 'VisualError: 未找到挑战按钮' }),
  ]]);
  const details = await f.service.getFailureDetails(id);
  assert.equal(details.errorMessage, 'VisualError: 未找到挑战按钮');
  assert.equal(details.logs.length, 3);
  f.service.close();
});

test('failure details reject invalid IDs before Redis access and reject cross-task or malformed snapshots', async () => {
  const f = failureFixture();
  for (const invalid of ['invalid', `${id}\n`, ` ${id}`, '../another'])
    await assert.rejects(f.service.getFailureDetails(invalid), { status: 400 });
  assert.equal(f.calls, 0);
  for (const snapshot of [
    [JSON.stringify({ ...run, taskId: owner }), []],
    ['private:not-json', []],
    [null, Array.from({ length: 12 }, (_, index) => log(12 - index))],
    [null, [log(1), log(2)]],
    [null, [log(2), log(2)]],
    [null, [['bad-id', []]]],
    [null, [], 'extra'],
  ]) {
    f.setSnapshot(snapshot);
    await assert.rejects(f.service.getFailureDetails(id), error => {
      assert.equal((error as { code: string }).code, 'TASK_RUN_DATA_INVALID');
      assert.doesNotMatch(String(error), /private/); return true;
    });
  }
  f.service.close();
});

test('最近任务仅从用户持久记录恢复，二维码过期仍可读取且不访问 Redis 或重新派发', async () => {
  const f = fixture();
  const latest = await f.service.getLatest(owner);
  assert.deepEqual(latest, { task: { id, createdAt: event.createdAt, expiresAt: event.expiresAt, status: 'expired',
    userOptions: { equipmentStamina: true, secretRealmMode: 'all' }, loginType: 'android_qq' } });
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
  assert.doesNotMatch(JSON.stringify(result), /accessToken|requestId|userId|workerId|sequence|"secret"/);
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

test('独立执行记录恢复装备体力和三种秘境模式，二维码过期或 Redis 快照缺省都不覆盖设置', async () => {
  for (const equipmentStamina of [true, false]) for (const secretRealmMode of ['once', 'all', 'skip'] as const) {
    const f = fixture();
    const userOptions = { equipmentStamina, secretRealmMode };
    f.records.set(id, { ...event, userOptions });
    assert.deepEqual((await f.service.getLatest(owner)).task?.userOptions, userOptions);
    const result = await f.service.getEvents(id, owner);
    assert.equal(result.task.status, 'expired');
    assert.equal(result.run?.status, 'running_daily');
    assert.deepEqual(result.task.userOptions, userOptions);
    f.service.close();
  }
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

test('授权完成与登录收尾状态可独立于二维码到期读取，授权时间只接受有效时间戳', async () => {
  const f = fixture();
  f.setSnapshot([JSON.stringify({ ...run, status: 'finishing_login', authorizedAt: at, startedAt: null }), [], '', 0, 0]);
  const result = await f.service.getEvents(id, owner);
  assert.equal(result.task.status, 'expired');
  assert.equal(result.run?.status, 'finishing_login');
  assert.equal(result.run?.authorizedAt, at);
  assert.equal(result.run?.startedAt, null);
  f.setSnapshot([JSON.stringify({ ...run, status: 'failed', authorizedAt: at, startedAt: null, errorCode: 'login_finish_timeout' }), [], '', 0, 0]);
  assert.equal((await f.service.getEvents(id, owner)).run?.authorizedAt, at);
  f.setSnapshot([JSON.stringify({ ...run, authorizedAt: 'private-invalid-value' }), [], '', 0, 0]);
  await assert.rejects(f.service.getEvents(id, owner), { code: 'TASK_RUN_DATA_INVALID' });
});

test('首次秘境完成时间随运行快照和终态透传，缺字段兼容而无效时间拒绝', async () => {
  const f = fixture();
  assert.equal((await f.service.getEvents(id, owner)).run?.secretRealmCompletedAt, undefined);
  for (const status of ['running_daily', 'completed', 'failed', 'interrupted']) {
    f.setSnapshot([JSON.stringify({ ...run, status, secretRealmCompletedAt: at,
      ...(status === 'failed' ? { errorCode: 'daily_timeout', finishedAt: at } : {}) }), [], '', 0, 0]);
    const restored = await f.service.getEvents(id, owner);
    assert.equal(restored.task.status, 'expired');
    assert.equal(restored.run?.status, status);
    assert.equal(restored.run?.secretRealmCompletedAt, at);
    assert.doesNotMatch(JSON.stringify(restored.run), /private-worker|private-token|workerId|sequence|accessToken/);
  }
  f.driver.eval = async () => [JSON.stringify({ ...run, secretRealmCompletedAt: at })];
  assert.equal((await f.service.getSummaries([id]))[0]?.secretRealmCompletedAt, at);
  f.service.close();
  const invalidFixture = fixture();
  for (const invalid of ['invalid', '2026-99-99T00:00:00.000Z', null, true, 123, {}]) {
    invalidFixture.setSnapshot([JSON.stringify({ ...run, secretRealmCompletedAt: invalid }), [], '', 0, 0]);
    await assert.rejects(invalidFixture.service.getEvents(id, owner), { code: 'TASK_RUN_DATA_INVALID' });
  }
  invalidFixture.service.close();
});
