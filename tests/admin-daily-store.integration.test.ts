import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { PgAuthStore } from '../src/server/database.js';

const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
const { Pool } = requireServer('pg') as { Pool: { prototype: {
  connect(): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<unknown>;
} } };
const start = new Date('2026-11-03T16:00:00.000Z');
const end = new Date('2026-11-04T16:00:00.000Z');
const userId = '10000000-0000-4000-8000-000000000001';
const eventId = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function fixture(t: TestContext) {
  const db = new PGlite();
  const store = new PgAuthStore('postgresql://fixture:fixture@database.invalid/fixture');
  t.after(async () => { await store.close(); await db.close(); });
  // These tests exercise requests after schema initialization, without sockets or cloud data.
  t.mock.method(store, 'initialize', async () => {});
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  t.mock.method(Pool.prototype, 'connect', async () => {
    assert.fail('已初始化的列表请求不得借用连接或开启显式事务');
  });
  t.mock.method(Pool.prototype, 'query', async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return db.query(sql, values);
  });
  await db.exec(`CREATE SCHEMA naruto_login;
    CREATE TABLE naruto_login.users (
      id uuid PRIMARY KEY, username text NOT NULL, admin_note text, password text NOT NULL
    );
    CREATE TABLE naruto_login.login_events (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES naruto_login.users(id),
      created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      status text NOT NULL, login_type text, user_options jsonb NOT NULL,
      request_id text NOT NULL, access_token text NOT NULL, token_hash text NOT NULL
    );`);
  await db.query(`INSERT INTO naruto_login.users VALUES ($1, $2, $3, $4)`,
    [userId, '虚构玩家', "测试备注'; DROP TABLE users;--", 'fixture-password-secret']);
  async function insert(index: number, createdAt = start, userOptions: unknown = {}, loginType: string | null = 'android_qq') {
    await db.query(`INSERT INTO naruto_login.login_events
      (id, user_id, created_at, expires_at, status, login_type, user_options, request_id, access_token, token_hash)
      VALUES ($1, $2, $3, $4, 'qr_ready', $5, $6, $7, $8, $9)`,
    [eventId(index), userId, createdAt, new Date(createdAt.getTime() + 300000), loginType,
      JSON.stringify(userOptions), `fixture-private-request-${index}`, 'fixture-access-secret', 'fixture-hash-secret']);
  }
  function assertSingleRead() {
    assert.equal(calls.length, 1, '每次列表读取只能执行一条查询');
    assert.match(calls[0].sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(calls[0].sql, /\b(?:COUNT|LIMIT|OFFSET|BEGIN|COMMIT)\b/i);
  }
  return { db, store, calls, insert, assertSingleRead };
}

test('真实SQL一次返回超过两页的全部记录，总数一致且同时间按ID倒序', async t => {
  const f = await fixture(t);
  // Insert in ascending ID order: PostgreSQL must perform the descending tie-break.
  for (let index = 1; index <= 47; index++) await f.insert(index);
  await f.insert(48, new Date('2026-11-04T01:00:00Z'));
  const result = await f.store.listDailyEvents(start, end);
  assert.equal(result.total, 48);
  assert.equal(result.items.length, 48);
  assert.deepEqual(result.items.map(item => item.id), [
    eventId(48), ...Array.from({ length: 47 }, (_, index) => eventId(47 - index)),
  ]);
  assert.equal(result.items[0].createdAt, '2026-11-04T01:00:00.000Z');
  assert.equal(result.items[0].expiresAt, '2026-11-04T01:05:00.000Z');
  f.assertSingleRead();
  assert.deepEqual(f.calls[0].values, [start, end, 'daily']);
});

test('真实SQL包含起点排除终点，默认日常兼容旧选项并隔离竞技场周任务', async t => {
  const f = await fixture(t);
  await f.insert(1, new Date(start.getTime() - 1));
  await f.insert(2, start);
  await f.insert(3, new Date(end.getTime() - 1), { mainTask: 'daily' });
  await f.insert(4, end);
  await f.insert(5, new Date('2026-11-04T00:00:00Z'), { mainTask: 'arena_weekly' });
  for (const [mainTask, expected] of [
    [undefined, [eventId(3), eventId(2)]],
    ['daily', [eventId(3), eventId(2)]],
    ['arena_weekly', [eventId(5)]],
  ] as const) {
    f.calls.length = 0;
    const result = await f.store.listDailyEvents(start, end, mainTask);
    assert.deepEqual(result.items.map(item => item.id), expected);
    assert.equal(result.total, expected.length);
    f.assertSingleRead();
    assert.deepEqual(f.calls[0].values, [start, end, mainTask ?? 'daily']);
  }
});

test('真实SQL读取旧选项、备注和登录渠道，只返回公开字段', async t => {
  const f = await fixture(t);
  await f.insert(1, start, {}, null);
  await f.insert(2, start, { equipmentStamina: false, secretRealmOnce: true }, 'ios_qq');
  await f.insert(3, start, { secretRealmOnce: false }, 'android_wechat');
  await f.insert(4, start, { mainTask: 'daily', equipmentStamina: true, secretRealmMode: 'skip' }, 'ios_wechat');
  const result = await f.store.listDailyEvents(start, end);
  assert.deepEqual(result.items.map(item => [item.id, item.loginType, item.userOptions]), [
    [eventId(4), 'ios_wechat', { mainTask: 'daily', equipmentStamina: true, secretRealmMode: 'skip' }],
    [eventId(3), 'android_wechat', { equipmentStamina: true, secretRealmMode: 'all' }],
    [eventId(2), 'ios_qq', { equipmentStamina: false, secretRealmMode: 'once' }],
    [eventId(1), 'android_qq', { equipmentStamina: true, secretRealmMode: 'all' }],
  ]);
  for (const item of result.items) {
    assert.equal(item.username, '虚构玩家');
    assert.equal(item.note, "测试备注'; DROP TABLE users;--");
    assert.equal(item.status, 'qr_ready');
    assert.deepEqual(Object.keys(item).sort(),
      ['createdAt', 'expiresAt', 'id', 'loginType', 'note', 'status', 'userOptions', 'username']);
  }
  assert.doesNotMatch(JSON.stringify(result), /fixture-(?:password|access|hash)-secret|fixture-private-request|password|access_token|token_hash|request_id/i);
  f.assertSingleRead();
});

test('真实SQL没有匹配记录时返回空列表和零总数', async t => {
  const f = await fixture(t);
  await f.insert(1, start, { mainTask: 'arena_weekly' });
  assert.deepEqual(await f.store.listDailyEvents(start, end), { items: [], total: 0 });
  f.assertSingleRead();
});

test('真实SQL读取到非法持久选项时拒绝返回未经校验的数据', async t => {
  const f = await fixture(t);
  await f.insert(1, start, { secretRealmMode: 'invalid' });
  await assert.rejects(f.store.listDailyEvents(start, end), /Stored daily event user options are invalid/);
  f.assertSingleRead();
});
