import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlsTaskLogArchive, type SlsQuery, type SlsQueryResult } from '../src/server/sls-logs.js';
import { loadConfig } from '../src/server/config.js';
import { privateTaskMessages, publicTaskMessages } from './private-task-log-fixtures.js';

const taskId = '123e4567-e89b-42d3-a456-426614174000';
const time = '2027-01-15T08:00:00.000Z';
const ms = '1800000000000';
const id = (n: number) => `${ms}-${n}`;
const config = { endpoint: 'cn-hangzhou.log.aliyuncs.com', project: 'fixture-project', logstore: 'fixture-logs',
  accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' };
function fixture(total = 205) {
  let data: Array<Record<string, unknown>> = Array.from({ length: total }, (_, i) => ({ taskId, environment: 'test', id: id(i + 1), time,
    level: ['INFO', 'WARNING', 'ERROR'][i % 3], message: `日志 ${i + 1}`, streamMs: ms, streamSeq: String(i + 1),
    actionIndex: '2', actionTotal: '38' }));
  const queries: string[] = [];
  let intercept: ((result: SlsQueryResult) => SlsQueryResult) | undefined;
  const query: SlsQuery = async (sql, from, to, timeoutMs) => {
    queries.push(sql);
    assert(sql.includes(`taskId: "${taskId}" AND environment: "test"`));
    assert(sql.includes(`"taskId" = '${taskId}' AND "environment" = 'test'`));
    assert.doesNotMatch(sql, /checkpoint|count\(|firstId|throughId|entryCount/);
    assert(to > from); assert(timeoutMs > 0);
    assert(sql.indexOf('GROUP BY "id"') < sql.indexOf('LIMIT'));
    const after = Number(sql.match(/"streamSeq" > (\d+)\)/)?.[1] ?? 0);
    const afterMs = Number(sql.match(/"streamMs" > (\d+) OR/)?.[1] ?? 0);
    const sqlFiltersPositions = sql.includes(`"id" = concat(cast("streamMs" AS varchar), '-', cast("streamSeq" AS varchar))`)
      && ['"streamMs" IS NOT NULL', '"streamSeq" IS NOT NULL', '"streamMs" >= 0', '"streamSeq" >= 0'].every(part => sql.includes(part));
    // Model SLS WHERE before GROUP BY/ORDER BY/LIMIT; corrupt source rows must not occupy the limit.
    const candidates = data.filter(row => (!sqlFiltersPositions || row.streamMs != null && row.streamSeq != null
      && /^\d+$/.test(String(row.streamMs)) && /^\d+$/.test(String(row.streamSeq))
      && row.id === `${Number(row.streamMs)}-${Number(row.streamSeq)}`)
      && (Number(row.streamMs) > afterMs || Number(row.streamMs) === afterMs && Number(row.streamSeq) > after));
    const rows = [...new Map(candidates.map(row => [row.id, row])).values()]
      .sort((a, b) => (Number(a.streamMs) - Number(b.streamMs) || Number(a.streamSeq) - Number(b.streamSeq))
        * (sql.includes('"streamMs" DESC') ? -1 : 1))
      .slice(0, Number(sql.match(/LIMIT (\d+)$/)?.[1]));
    const result = { progress: 'Complete', data: rows };
    return intercept ? intercept(result) : result;
  };
  const archive = new SlsTaskLogArchive(config, 'test', 1000, { query, now: () => Date.parse(time) });
  return { archive, queries, get data() { return data; }, set data(value) { data = value; },
    set intercept(value: typeof intercept) { intercept = value; } };
}

test('SLS 每页只查一次正文，去重并按数值游标读取超过2000条', async () => {
  const f = fixture(2050);
  f.data = [...f.data, ...f.data.slice(0, 150)];
  let after = '0-0';
  const collected: string[] = [];
  for (let offset = 0; offset < 2050; offset += 100) {
    const page = await f.archive.read(taskId, after);
    assert(page);
    assert.equal(page.logs.length, Math.min(100, 2050 - offset));
    assert.equal(page.hasMore, offset + 100 < 2050);
    assert.equal(page.truncated, false);
    collected.push(...page.logs.map(row => row.id));
    after = page.nextCursor;
    assert.equal(f.queries.length, offset / 100 + 1);
  }
  assert.equal(new Set(collected).size, 2050);
  assert.equal(after, id(2050));
});

test('SLS 空页可再次读取，新到日志和中间缺口不等待检查点', async () => {
  const f = fixture(3);
  f.data = f.data.filter(row => row.id !== id(2));
  const page = await f.archive.read(taskId, '0-0');
  assert(page); assert.deepEqual(page.logs.map(row => row.id), [id(1), id(3)]);
  const empty = await f.archive.read(taskId, page.nextCursor);
  assert.deepEqual(empty, { logs: [], nextCursor: id(3), hasMore: false, truncated: false });
  f.data = [...f.data, { ...f.data[0], id: id(4), streamSeq: '4' }];
  assert.equal((await f.archive.read(taskId, empty!.nextCursor))?.logs[0].id, id(4));
  assert.equal(f.queries.length, 3);
});

test('SLS Incomplete 仍展示已读正文，真正超时或服务错误明确失败', async () => {
  const f = fixture(2);
  f.intercept = result => ({ ...result, progress: 'Incomplete' });
  assert.equal((await f.archive.read(taskId, '0-0'))?.logs.length, 2);
  assert.equal(f.queries.length, 1);
  const timeout = new SlsTaskLogArchive(config, 'test', 10, { query: async () => new Promise(() => {}) });
  await assert.rejects(timeout.read(taskId, '0-0'), /timed out/);
  const broken = new SlsTaskLogArchive(config, 'test', 100, { query: async () => { throw new Error('fixture failure'); } });
  await assert.rejects(broken.read(taskId, '0-0'), /fixture failure/);
});

test('SLS 整页内部或坏正文推进原始游标，下一页仍可读取公开内容', async () => {
  const f = fixture(101);
  f.data = f.data.map((row, i) => ({ ...row, message: i < 100 ? privateTaskMessages[0] : publicTaskMessages[0] }));
  f.intercept = result => ({ ...result, data: (result.data as object[]).map((row, i) => i === 0 ? { ...row, time: 'bad' } : row) });
  const first = await f.archive.read(taskId, '0-0');
  assert(first); assert.deepEqual(first.logs, []); assert.equal(first.nextCursor, id(100));
  assert.equal(first.hasMore, true); assert.equal(first.truncated, true);
  f.intercept = undefined;
  const second = await f.archive.read(taskId, first.nextCursor);
  assert(second); assert.deepEqual(second.logs.map(row => row.message), [publicTaskMessages[0]]);
  assert.equal(second.nextCursor, id(101));
});

test('SLS 任务与环境隔离，异常ID与倒序数据均不能泄露或卡住游标', async () => {
  for (const patch of [{ environment: 'prod' }, { taskId: 'other' }]) {
    const f = fixture(2);
    f.intercept = result => ({ ...result, data: (result.data as object[]).map(row => ({ ...row, ...patch })) });
    await assert.rejects(f.archive.read(taskId, '0-0'));
  }
  const f = fixture(2);
  assert.equal(await f.archive.read("' OR 1=1", '0-0'), null);
  assert.equal(await f.archive.read(taskId, '01-0'), null);
  assert.equal(f.queries.length, 0);
  f.intercept = result => ({ ...result, data: [...result.data as unknown[]].reverse() });
  await assert.rejects(f.archive.read(taskId, '0-0'));
});

test('SLS 在分页前排除坏编号，同页正常正文立即可读且不增加查询', async () => {
  for (const tail of [false, true]) {
    const f = fixture(5);
    f.data = f.data.map(row => ['2', '5'].includes(String(row.streamSeq)) ? { ...row, id: `broken-${row.streamSeq}` }
      : row.streamSeq === '3' ? { ...row, id: id(1000) } : row);
    const page = await f.archive.read(taskId, '0-0', tail);
    assert(page); assert.deepEqual(page.logs.map(row => row.id), (tail ? [4, 1] : [1, 4]).map(id));
    assert.equal(page.nextCursor, id(4)); assert.equal(page.truncated, false); assert.equal(f.queries.length, 1);
    const next = await f.archive.read(taskId, page.nextCursor, tail);
    assert(next); assert.deepEqual(next.logs, []); assert.equal(next.nextCursor, id(4)); assert.equal(f.queries.length, 2);
  }
});

test('SLS 在分页前排除没有可信数值坐标的坏行，保留同页正常正文', async () => {
  const f = fixture(4);
  f.data = f.data.map((row, i) => i === 1 ? { ...row, streamMs: null } : i === 2 ? { ...row, streamSeq: -1 } : row);
  const page = await f.archive.read(taskId, '0-0');
  assert(page); assert.deepEqual(page.logs.map(row => row.id), [id(1), id(4)]);
  assert.equal(page.nextCursor, id(4)); assert.equal(page.truncated, false); assert.equal(f.queries.length, 1);
});

test('SLS 坏坐标占满原始页时仍读取同次查询内最后一条可信正文', async () => {
  const f = fixture(101);
  f.data = f.data.map((row, i) => i < 100 ? { ...row, streamSeq: null } : row);
  const page = await f.archive.read(taskId, '0-0');
  assert(page); assert.deepEqual(page.logs.map(row => row.id), [id(101)]);
  assert.equal(page.nextCursor, id(101)); assert.equal(page.truncated, false); assert.equal(f.queries.length, 1);
});

test('SLS 第100条坏编号与第101条正常正文同坐标时不丢正常正文', async () => {
  const f = fixture(100);
  f.data = [...f.data.slice(0, 99), { ...f.data[99], id: 'broken-id' }, f.data[99]];
  const page = await f.archive.read(taskId, '0-0');
  assert(page); assert.equal(page.logs.length, 100); assert.equal(page.logs.at(-1)?.id, id(100));
  assert.equal(page.nextCursor, id(100)); assert.equal(page.hasMore, false); assert.equal(f.queries.length, 1);
});

test('SLS 101条空坐标在分页前排除，空页不声明还有下一页', async () => {
  const f = fixture(101);
  f.data = f.data.map(row => ({ ...row, streamSeq: null }));
  const page = await f.archive.read(taskId, '0-0');
  assert.deepEqual(page, { logs: [], nextCursor: '0-0', hasMore: false, truncated: false });
  assert.equal(f.queries.length, 1);
});

test('SLS 聚合缺失进度兼容字符串null，错误进度跳过但游标继续', async () => {
  const f = fixture(2);
  f.intercept = result => ({ ...result, data: (result.data as object[]).map((row, i) => ({ ...row,
    actionIndex: i ? 'invalid' : 'null', actionTotal: i ? '38' : 'null' })) });
  const page = await f.archive.read(taskId, '0-0');
  assert(page); assert.deepEqual(page.logs, [{ id: id(1), time, level: 'INFO', message: '日志 1' }]);
  assert.equal(page.nextCursor, id(2)); assert.equal(page.truncated, true);
});

test('SLS 失败详情倒序取最新十一条并只用批量上限判断还有日志', async () => {
  const f = fixture(30);
  const page = await f.archive.read(taskId, '0-0', true);
  assert(page); assert.equal(page.logs[0].id, id(30)); assert.equal(page.logs.at(-1)?.id, id(20));
  assert.equal(page.hasMore, true); assert.equal(page.nextCursor, id(30)); assert.equal(f.queries.length, 1);
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
