import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { PgAuthStore } from '../src/server/database.js';

const require = createRequire(new URL('../src/server/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
const { Pool } = require('pg') as { Pool: { prototype: { connect(): Promise<unknown> } } };
const start = new Date('2026-09-30T16:00:00Z'), end = new Date('2026-10-31T16:00:00Z');

async function fixture(t: TestContext) {
  const db = new PGlite();
  // Forward the real store's SQL to PostgreSQL; no test code computes ranks or sorting.
  const query = (sql: string, values?: unknown[]) => values ? db.query(sql, values)
    : db.exec(sql).then(results => results.at(-1) ?? { rows: [] });
  t.mock.method(Pool.prototype, 'connect', async () => ({ query, release() {} }));
  const store = new PgAuthStore('postgresql://fixture:fixture@db.invalid/fixture');
  t.after(async () => { await store.close(); await db.close(); });
  await store.initialize();
  // Tied usernames have IDs and notes in the opposite order from the registered names.
  for (const [suffix, username, note, days] of [
    ['9', '10', '文', [1, 1, 2, 2]],
    ['8', '2', '中', [1, 1, 2, 2]],
    ['7', 'Zed', 'alice', [1, 1, 2, 2]],
    ['6', 'alice', 'Zed', [1, 1, 2, 2]],
    ['5', '中', '2', [1, 1, 2, 2]],
    ['4', '文', '10', [1, 1, 2, 2]],
    ['3', 'zz-count', '', [1, 1, 1, 1, 1, 1]],
    ['2', 'zz-days', '', [1, 2, 3]],
    ['1', 'xx-less-days', '', [1, 1, 1, 1]],
  ] as const) {
    const userId = `10000000-0000-4000-8000-00000000000${suffix}`;
    await db.query(`INSERT INTO naruto_login.users (id, username, username_key, password, admin_note)
      VALUES ($1, $2, $3, 'fixture', $4)`, [userId, username, username.toLowerCase(), note]);
    for (const [index, day] of days.entries()) {
      const createdAt = new Date(`2026-10-0${day}T04:00:00Z`);
      await db.query(`INSERT INTO naruto_login.login_events
        (id, user_id, request_id, status, access_token, created_at, expires_at, finished_at)
        VALUES ($1, $2, $3, 'expired', $4, $5, $6, $6)`,
      [`20000000-0000-4000-8000-0000000000${suffix}${index}`, userId, `request-${index}`, '0'.repeat(64),
        createdAt, new Date(createdAt.getTime() + 300000)]);
    }
  }
  return store;
}

test('次数月榜按次数、天数和注册用户名排序，名次连续且跨页不中断', async t => {
  const store = await fixture(t);
  const result = await store.listMonthlyStats(start, end, 'requests', 0, 20);
  assert.equal(result.total, 9);
  assert.equal(result.totalRequests, 37);
  assert.deepEqual(result.items.map(item => [item.username, item.rank, item.requestCount, item.requestDays]), [
    ['zz-count', 1, 6, 1],
    ['10', 2, 4, 2],
    ['2', 3, 4, 2],
    ['Zed', 4, 4, 2],
    ['alice', 5, 4, 2],
    ['中', 6, 4, 2],
    ['文', 7, 4, 2],
    ['xx-less-days', 8, 4, 1],
    ['zz-days', 9, 3, 3],
  ]);
  const first = await store.listMonthlyStats(start, end, 'requests', 0, 4);
  const second = await store.listMonthlyStats(start, end, 'requests', 4, 4);
  const third = await store.listMonthlyStats(start, end, 'requests', 8, 4);
  assert.deepEqual(first.items.map(item => [item.username, item.rank]), [['zz-count', 1], ['10', 2], ['2', 3], ['Zed', 4]]);
  assert.deepEqual(second.items.map(item => [item.username, item.rank]), [['alice', 5], ['中', 6], ['文', 7], ['xx-less-days', 8]]);
  assert.deepEqual(third.items.map(item => [item.username, item.rank]), [['zz-days', 9]]);
});

test('天数月榜保留天数和次数优先级，数字、大小写及中文按用户名排且不看备注或ID', async t => {
  const store = await fixture(t);
  const result = await store.listMonthlyStats(start, end, 'days', 0, 20);
  assert.deepEqual(result.items.map(item => [item.username, item.rank, item.requestCount, item.requestDays]), [
    ['zz-days', 1, 3, 3],
    ['10', 2, 4, 2],
    ['2', 3, 4, 2],
    ['Zed', 4, 4, 2],
    ['alice', 5, 4, 2],
    ['中', 6, 4, 2],
    ['文', 7, 4, 2],
    ['zz-count', 8, 6, 1],
    ['xx-less-days', 9, 4, 1],
  ]);
  const first = await store.listMonthlyStats(start, end, 'days', 0, 4);
  const second = await store.listMonthlyStats(start, end, 'days', 4, 4);
  const third = await store.listMonthlyStats(start, end, 'days', 8, 4);
  assert.deepEqual(first.items.map(item => [item.username, item.rank]), [['zz-days', 1], ['10', 2], ['2', 3], ['Zed', 4]]);
  assert.deepEqual(second.items.map(item => [item.username, item.rank]), [['alice', 5], ['中', 6], ['文', 7], ['zz-count', 8]]);
  assert.deepEqual(third.items.map(item => [item.username, item.rank]), [['xx-less-days', 9]]);
});
