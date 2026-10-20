import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlsTaskLogArchive, type SlsQuery, type SlsQueryResult } from '../src/server/sls-logs.js';
import { TaskRunService, type RunRedisDriver } from '../src/server/task-runs.js';
import { loadConfig } from '../src/server/config.js';

const taskId = '123e4567-e89b-42d3-a456-426614174000';
const time = '2027-01-15T08:00:00.000Z';
const ms = '1800000000000';
const id = (n: number) => `${ms}-${n}`;
const config = { endpoint: 'cn-hangzhou.log.aliyuncs.com', project: 'fixture-project', logstore: 'fixture-logs',
  accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' };
function fixture(total = 205) {
  let data = Array.from({ length: total }, (_, i) => ({ taskId, environment: 'test', id: id(i + 1), time,
    level: ['INFO', 'WARNING', 'ERROR'][i % 3], message: `日志 ${i + 1}`, streamMs: ms, streamSeq: String(i + 1),
    actionIndex: '2', actionTotal: '38' }));
  let marker: Record<string, unknown> = { taskId, environment: 'test', firstId: id(1), throughId: id(total),
    entryCount: String(total), truncated: 'false', streamMs: ms, streamSeq: String(total) };
  const queries: string[] = [];
  let intercept: ((result: SlsQueryResult, sql: string) => SlsQueryResult) | undefined;
  const query: SlsQuery = async (sql, from, to, timeoutMs) => {
    queries.push(sql);
    assert(sql.includes(`taskId: "${taskId}" AND environment: "test"`));
    assert(sql.includes(`"taskId" = '${taskId}' AND "environment" = 'test'`));
    assert(to > from); assert(timeoutMs > 0);
    const unique = [...new Map(data.map(row => [row.id, row])).values()];
    const after = Number(sql.match(/"streamSeq" > (\d+)\)/)?.[1] ?? 0);
    const upper = Math.min(...[...sql.matchAll(/"streamSeq" <= (\d+)\)/g)].map(match => Number(match[1])));
    let rows: unknown[];
    if (sql.includes('SELECT DISTINCT')) rows = [marker];
    else if (sql.includes('count(DISTINCT')) rows = [{ entryCount: String(unique.length),
      remainingCount: String(unique.filter(row => Number(row.streamSeq) > after && Number(row.streamSeq) <= upper).length) }];
    else {
      assert(sql.indexOf('GROUP BY "id"') < sql.indexOf('LIMIT'));
      rows = unique.filter(row => Number(row.streamSeq) > after && Number(row.streamSeq) <= upper)
        .sort((a, b) => (Number(a.streamSeq) - Number(b.streamSeq)) * (sql.includes('"streamMs" DESC') ? -1 : 1))
        .slice(0, Number(sql.match(/LIMIT (\d+)$/)?.[1]));
    }
    const result = { progress: 'Complete', data: rows };
    return intercept ? intercept(result, sql) : result;
  };
  const archive = new SlsTaskLogArchive(config, 'test', 1000, { query, now: () => Date.parse(time) });
  return { archive, queries, get data() { return data; }, set data(value) { data = value; },
    set marker(value: Record<string, unknown>) { marker = { ...marker, ...value }; },
    set intercept(value: typeof intercept) { intercept = value; } };
}

test('SLS 历史日志在去重后按数值游标分页，固定快照覆盖超过 2000 条日志', async () => {
  const f = fixture(2050);
  f.data = [...f.data, ...f.data.slice(0, 150)];
  const collected: string[] = [];
  let after = '0-0';
  for (let offset = 0; offset < 2050; offset += 100) {
    const page = await f.archive.read(taskId, after, offset ? id(2050) : undefined,
      { exists: true, firstId: id(1), lastId: id(2050) });
    assert(page);
    assert.equal(page.logs.length, Math.min(100, 2050 - offset));
    assert.equal(page.snapshotCursor, id(2050));
    assert.equal(page.hasMore, offset + 100 < 2050);
    assert.equal(page.truncated, false);
    assert.equal(page.logs[0].id, id(offset + 1));
    collected.push(...page.logs.map(log => log.id));
    after = page.nextCursor;
  }
  assert.equal(collected.length, 2050); assert.equal(new Set(collected).size, 2050);
  assert.equal(after, id(2050));
});

test('SLS 分页固定上界，后续新日志不会改变已打开的快照', async () => {
  const f = fixture(205);
  const first = await f.archive.read(taskId, '0-0', undefined, { exists: true, firstId: id(1), lastId: id(200) });
  assert(first); assert.equal(first.snapshotCursor, id(200));
  const second = await f.archive.read(taskId, first.nextCursor, first.snapshotCursor,
    { exists: true, firstId: id(1), lastId: id(205) });
  assert(second); assert.equal(second.logs.at(-1)?.id, id(200));
  assert.equal(second.hasMore, false); assert.equal(second.nextCursor, id(200));
});

test('SLS 任务及环境隔离，错误 marker 或返回行拒绝使用', async () => {
  const f = fixture();
  for (const row of [{ environment: 'prod' }, { taskId: 'another-task' }]) {
    f.intercept = (result, sql) => sql.includes('SELECT DISTINCT')
      ? { ...result, data: (result.data as object[]).map(value => ({ ...value, ...row })) } : result;
    assert.equal(await f.archive.read(taskId, '0-0', undefined, undefined), null);
    f.intercept = (result, sql) => sql.includes('GROUP BY')
      ? { ...result, data: (result.data as object[]).map(value => ({ ...value, ...row })) } : result;
    assert.equal(await f.archive.read(taskId, '0-0', undefined, undefined), null);
  }
  assert.equal(await f.archive.read("' OR 1=1", '0-0', undefined, undefined), null);
});

test('SLS checkpoint 不能掩盖中间缺口、尚未索引的尾部、正文缺失或不完整查询', async () => {
  const f = fixture();
  assert.equal(await f.archive.read(taskId, '0-0', undefined, { exists: true, firstId: id(1), lastId: id(206) }), null);
  const original = f.data;
  f.data = f.data.filter(row => row.id !== id(40));
  assert.equal(await f.archive.read(taskId, '0-0', undefined, undefined), null);
  f.data = original;
  for (const stage of ['SELECT DISTINCT', 'count(DISTINCT', 'GROUP BY']) {
    f.intercept = (result, sql) => sql.includes(stage) ? { ...result, progress: 'Incomplete' } : result;
    assert.equal(await f.archive.read(taskId, '0-0', undefined, undefined), null);
  }
  f.intercept = (result, sql) => sql.includes('GROUP BY') ? { ...result, data: (result.data as unknown[]).slice(1) } : result;
  assert.equal(await f.archive.read(taskId, '0-0', undefined, undefined), null);
  f.intercept = (result, sql) => sql.includes('SELECT DISTINCT') ? { ...result, data: [] } : result;
  assert.equal(await f.archive.read(taskId, '0-0', undefined, undefined), null);
});

test('Redis 过期后凭完整 checkpoint 读取归档；原始裁剪必须显示缺失提示', async () => {
  const f = fixture();
  const archived = await f.archive.read(taskId, '0-0', undefined, { exists: false, firstId: '', lastId: '0-0' });
  assert(archived); assert.equal(archived.snapshotCursor, id(205));
  f.marker = { truncated: 'true' };
  assert.equal((await f.archive.read(taskId, '0-0', undefined, undefined))?.truncated, true);
  f.marker = { firstId: id(2) };
  assert.equal(await f.archive.read(taskId, '0-0', undefined, { exists: true, firstId: id(1), lastId: id(205) }), null);
});

function serviceFixture(archive: SlsTaskLogArchive) {
  const run = { taskId, status: 'failed', updatedAt: time, startedAt: time, finishedAt: time, errorCode: 'daily_failed' };
  const operations: string[] = [];
  const redisLog = [id(1), ['json', JSON.stringify({ time, level: 'ERROR', message: 'Redis 保底日志' })]];
  const driver: RunRedisDriver = { isReady: true, async connect() {}, destroy() {}, async eval(sql) {
    operations.push(sql);
    if (sql.includes('return {run, firstId, lastId, exists}')) return [JSON.stringify(run), id(1), id(205), 1];
    if (sql.includes('local upper')) return [JSON.stringify(run), [redisLog], id(205), id(1), 1, 1, 1];
    return [JSON.stringify(run), [redisLog]];
  } };
  const service = new TaskRunService({ redisUrl: 'redis://fixture', redisQueueKey: 'fixture', timeoutMs: 100 },
    { archive, createDriver: () => driver });
  return { service, operations, driver };
}

test('客户端详情优先 SLS，Redis 仅取状态和边界；失败详情从 SLS 最新十条提取错误', async () => {
  const f = fixture();
  f.data = f.data.map(row => row.id === id(204) ? { ...row, level: 'ERROR', message: '具体错误：未找到挑战按钮' } : row);
  const { service, operations } = serviceFixture(f.archive);
  const page = await service.getAdminLogPage(taskId);
  assert.equal(page.logs.length, 100); assert.equal(page.status, 'failed');
  assert.equal(operations.length, 1); assert.doesNotMatch(operations[0], /XRANGE|XREVRANGE/);
  const failure = await service.getFailureDetails(taskId);
  assert.equal(failure.logs.length, 10); assert.equal(failure.errorMessage, '具体错误：未找到挑战按钮');
  assert.equal(failure.logs[0].id, id(196)); assert.equal(failure.logs.at(-1)?.id, id(205));
  assert.equal(failure.truncated, true);
});

test('空归档、服务异常、Incomplete 和计数缺口自动使用既有 Redis 日志', async () => {
  for (const mode of ['empty', 'error', 'incomplete', 'gap']) {
    const f = fixture();
    f.intercept = result => {
      if (mode === 'error') throw new Error('provider-secret-must-not-be-exposed');
      if (mode === 'incomplete') return { ...result, progress: 'Incomplete' };
      if (mode === 'empty') return { ...result, data: [] };
      return result;
    };
    if (mode === 'gap') f.data = f.data.filter(row => row.id !== id(40));
    const { service } = serviceFixture(f.archive);
    assert.equal((await service.getAdminLogPage(taskId)).logs[0].message, 'Redis 保底日志');
    assert.equal((await service.getFailureDetails(taskId)).logs[0].message, 'Redis 保底日志');
  }
});

test('SLS 不参与普通用户实时读取且仍先做 PostgreSQL 归属鉴权', async () => {
  const f = fixture();
  const { driver } = serviceFixture(f.archive);
  const service = new TaskRunService({ redisUrl: 'redis://fixture', redisQueueKey: 'fixture', timeoutMs: 100 },
    { archive: f.archive, createDriver: () => driver, store: { async initialize() {}, async getEvent() { return null; }, async getLatestForUser() { return null; } } });
  await assert.rejects(service.getEvents(taskId, 'other-user'), { status: 404 });
  assert.equal(f.queries.length, 0);
});

test('SLS 慢请求有总超时边界并回退，Redis 已失败时不重复等待同一故障', async () => {
  const archive = new SlsTaskLogArchive(config, 'test', 10, { query: async () => new Promise(() => {}) });
  const { service } = serviceFixture(archive);
  assert.equal((await service.getAdminLogPage(taskId)).logs[0].message, 'Redis 保底日志');
  const f = fixture();
  f.intercept = result => ({ ...result, data: [] });
  const failed = serviceFixture(f.archive);
  let attempts = 0;
  failed.driver.eval = async () => { attempts++; throw new Error('Redis unavailable'); };
  await assert.rejects(failed.service.getAdminLogPage(taskId), { code: 'TASK_LOGS_UNAVAILABLE' });
  assert.equal(attempts, 1);
  const available = serviceFixture(fixture().archive);
  available.driver.eval = async () => { throw new Error('Redis unavailable'); };
  assert.equal((await available.service.getAdminLogPage(taskId)).logs.length, 100);
});

test('SLS 默认关闭，启用必须严格校验且错误不输出密钥；官方 SDK 能离线创建', () => {
  const env = { SLS_ENABLED: 'true', SLS_ENDPOINT: 'https://cn-hangzhou.log.aliyuncs.com', SLS_PROJECT: 'fixture-project',
    SLS_LOGSTORE: 'fixture-logs', SLS_ACCESS_KEY_ID: 'fixture-id', SLS_ACCESS_KEY_SECRET: 'fixture-secret', SLS_STS_TOKEN: 'fixture-token' };
  assert.equal(loadConfig({}).sls, undefined);
  assert.equal(loadConfig({ ...env, SLS_ENABLED: 'false' }).sls, undefined);
  const enabled = loadConfig(env).sls;
  assert(enabled); assert.equal(enabled.endpoint, 'cn-hangzhou.log.aliyuncs.com'); assert.equal(enabled.stsToken, 'fixture-token');
  for (const key of ['SLS_ENDPOINT', 'SLS_PROJECT', 'SLS_LOGSTORE', 'SLS_ACCESS_KEY_ID', 'SLS_ACCESS_KEY_SECRET']) {
    assert.throws(() => loadConfig({ ...env, [key]: '' }), error => error instanceof Error && error.message.includes(key)
      && !error.message.includes('fixture-secret') && !error.message.includes('fixture-token'));
  }
  for (const endpoint of ['http://cn-hangzhou.log.aliyuncs.com', 'https://attacker.invalid', 'cn-hangzhou.log.aliyuncs.com/path']) {
    assert.throws(() => loadConfig({ ...env, SLS_ENDPOINT: endpoint }), /SLS_ENDPOINT/);
  }
  assert.throws(() => loadConfig({ SLS_ENABLED: 'yes' }), /SLS_ENABLED/);
  assert.doesNotThrow(() => new SlsTaskLogArchive(enabled, 'test', 100));
});
