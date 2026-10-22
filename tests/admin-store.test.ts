import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { PgAuthStore, UserManagementError, UsernameTakenError, type StoredUser, type UserChanges } from '../src/server/database.js';

const { Pool } = createRequire(new URL('../src/server/package.json', import.meta.url))('pg') as {
  Pool: { prototype: { connect(): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<unknown> } };
};
const adminId = '10000000-0000-4000-8000-000000000001', id = '10000000-0000-4000-8000-000000000002';
const now = new Date('2026-10-08T00:00:00.000Z');
const row = { id, username: 'Naruto', isInvalid: true, isAdmin: false, createdAt: now, applicationStatus: 'pending' };
const changes: UserChanges = { username: 'Naruto_2', usernameKey: 'naruto_2', isInvalid: false, isAdmin: false };

function fixture(t: TestContext) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let actor = true, missing = false, failure: unknown, userOptions: unknown, note = '';
  async function query(text: string, values: unknown[] = []) {
    const sql = text.replace(/\s+/g, ' ').trim(); calls.push({ sql, values });
    if (sql.includes('FOR SHARE')) return { rows: actor ? [{ id: adminId }] : [] };
    if (sql.startsWith('INSERT INTO naruto_login.users') || sql.startsWith('UPDATE naruto_login.users') || sql.startsWith('DELETE FROM naruto_login.users')) {
      if (failure) throw failure;
      if (sql.startsWith('INSERT') && sql.includes('admin_note')) note = String(values[7]);
      if (sql.startsWith('UPDATE') && sql.includes('admin_note = COALESCE($7, admin_note)') && values[6] !== null) note = String(values[6]);
      return { rows: missing ? [] : [{ ...row, note, username: changes.username }] };
    }
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ total: 41 }] };
    if (sql.startsWith('SELECT count(DISTINCT user_id)')) return { rows: [{ total: 41, totalRequests: 120 }] };
    if (sql.startsWith('WITH stats AS')) return { rows: [{ userId: id, username: 'Naruto', note, requestCount: 9, requestDays: 3, rank: 1, password: 'private-fixture' }] };
    if (sql.includes('FROM naruto_login.users u')) return { rows: missing ? [] : [{ ...row, note, password: 'private-fixture' }] };
    if (sql.includes('FROM naruto_login.login_events e')) return { rows: [{ id, username: row.username, note, createdAt: now, expiresAt: new Date(now.getTime() + 300000), status: 'qr_ready', userOptions, accessToken: 'private-token' }] };
    return { rows: [] };
  }
  t.mock.method(Pool.prototype, 'connect', async () => ({ query, release() {} }));
  t.mock.method(Pool.prototype, 'query', query);
  const store = new PgAuthStore('postgresql://fixture:fixture@127.0.0.1/fixture'); t.after(() => store.close());
  return { store, calls, setActor(value: boolean) { actor = value; }, setMissing(value: boolean) { missing = value; },
    setFailure(value: unknown) { failure = value; }, setUserOptions(value: unknown) { userOptions = value; }, setNote(value: string) { note = value; } };
}

test('admin lists use literal parameterized search, consistent count/page snapshots and public fields', async t => {
  const f = fixture(t);
  const result = await f.store.listUsers("Naru_to'", 20, 20);
  assert.equal(result.total, 41); assert.equal(result.items[0].createdAt, now.toISOString());
  assert.doesNotMatch(JSON.stringify(result), /password|private-fixture/);
  const search = f.calls.find(call => call.sql.includes('ORDER BY u.created_at DESC'))!;
  const condition = "(strpos(lower(u.username), lower($1)) > 0 OR strpos(lower(u.admin_note), lower($1)) > 0)";
  assert.ok(search.sql.includes(`WHERE ${condition}`));
  const count = f.calls.find(call => call.sql.startsWith('SELECT count(*)') && call.sql.includes('FROM naruto_login.users'))!;
  assert.ok(count.sql.endsWith(`WHERE ${condition}`));
  assert.deepEqual(count.values, ["Naru_to'"]);
  assert.deepEqual(search.values, ["Naru_to'", 20, 20]);
  assert.ok(!search.sql.includes("Naru_to'"));
  assert.ok(f.calls.some(call => call.sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));
  assert.equal((await f.store.getManagedUser(id))?.applicationStatus, 'pending');
  f.setMissing(true); assert.equal(await f.store.getManagedUser(id), null);
});

test('create locks live admin privileges, binds role/status/password and maps only username uniqueness conflicts', async t => {
  const f = fixture(t);
  const user: StoredUser = { id, username: 'Naruto', usernameKey: 'naruto', password: 'private-password', isAdmin: true, isInvalid: false };
  const result = await f.store.createUser(adminId, user, now);
  assert.equal(result.isAdmin, true); assert.equal(result.isInvalid, false); assert.equal(result.applicationStatus, null);
  assert.doesNotMatch(JSON.stringify(result), /password|private-password/);
  const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO naruto_login.users'))!;
  assert.deepEqual(insert.values, [id, 'Naruto', 'naruto', 'private-password', false, true, now, '']);
  assert.equal(result.note, '');
  const lock = f.calls.findIndex(call => call.sql.includes('FOR SHARE'));
  assert.ok(lock >= 0 && lock < f.calls.indexOf(insert));
  f.setFailure({ code: '23505', constraint: 'naruto_login_users_username_key_key' });
  await assert.rejects(f.store.createUser(adminId, user, now), UsernameTakenError);
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  f.setActor(false); const inserts = f.calls.filter(call => call.sql.startsWith('INSERT INTO naruto_login.users')).length;
  await assert.rejects(f.store.createUser(adminId, user, now), error => error instanceof UserManagementError && error.code === 'ADMIN_REQUIRED');
  assert.equal(f.calls.filter(call => call.sql.startsWith('INSERT INTO naruto_login.users')).length, inserts);
});

test('activation resolves pending registration in the same transaction; blank password never overwrites storage', async t => {
  const f = fixture(t);
  const updated = await f.store.updateUser(adminId, id, changes, now);
  assert.equal(updated.applicationStatus, 'approved');
  const update = f.calls.find(call => call.sql.startsWith('UPDATE naruto_login.users'))!;
  assert.match(update.sql, /password = COALESCE\(\$4, password\)/);
  assert.deepEqual(update.values, [id, 'Naruto_2', 'naruto_2', null, false, false, null]);
  const review = f.calls.find(call => call.sql.startsWith('UPDATE naruto_login.registration_applications'))!;
  assert.deepEqual(review.values, [id, now, adminId]); assert.match(review.sql, /status = 'pending'/);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  f.setFailure(new Error('storage failed'));
  await assert.rejects(f.store.updateUser(adminId, id, changes, now)); assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
});

test('管理员备注独立持久化，省略保持、空串清空，扫码和月榜读取当前备注', async t => {
  const f = fixture(t);
  const note = "群友_小明'; DROP TABLE users;--";
  const created = await f.store.createUser(adminId, { id, username: 'Naruto', usernameKey: 'naruto',
    password: 'fixture-password', isAdmin: false, isInvalid: false, note }, now);
  assert.equal(created.note, note);
  assert.equal(created.username, 'Naruto');
  assert.equal((await f.store.getManagedUser(id))?.note, note);
  assert.equal((await f.store.listUsers(note, 0, 20)).items[0].note, note);
  const input = { ...changes, username: 'Naruto', usernameKey: 'naruto' };
  assert.equal((await f.store.updateUser(adminId, id, input, now)).note, note);
  const updated = await f.store.updateUser(adminId, id, { ...input, note: '新备注' }, now);
  assert.equal(updated.note, '新备注');
  assert.equal((await f.store.listDailyEvents(now, new Date(now.getTime() + 300000), 0, 20)).items[0].note, '新备注');
  assert.equal((await f.store.listMonthlyStats(now, new Date(now.getTime() + 300000), 'requests', 0, 20)).items[0].note, '新备注');
  const taskQuery = f.calls.find(call => call.sql.includes('FROM naruto_login.login_events e'))!;
  const monthlyQuery = f.calls.find(call => call.sql.startsWith('WITH stats AS'))!;
  for (const query of [taskQuery, monthlyQuery]) assert.match(query.sql, /u.admin_note AS note/);
  assert.equal((await f.store.updateUser(adminId, id, { ...input, note: '' }, now)).note, '');
  assert.equal((await f.store.getManagedUser(id))?.note, '');
  const mutations = f.calls.filter(call => call.sql.startsWith('UPDATE naruto_login.users'));
  assert.ok(mutations.every(call => call.values[1] === 'Naruto' && call.values[2] === 'naruto'));
  assert.ok(f.calls.every(call => !call.sql.includes(note)));
  f.setActor(false);
  const before = mutations.length;
  await assert.rejects(f.store.updateUser(adminId, id, { ...input, note: '越权修改' }, now),
    error => error instanceof UserManagementError && error.code === 'ADMIN_REQUIRED');
  assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE naruto_login.users')).length, before);
});

test('store defends self mutations and missing targets and deletes through the existing foreign-key cascades', async t => {
  const f = fixture(t);
  await assert.rejects(f.store.deleteUser(adminId, adminId), error => error instanceof UserManagementError && error.code === 'SELF_PROTECTED');
  await assert.rejects(f.store.updateUser(adminId, adminId, changes, now), error => error instanceof UserManagementError && error.code === 'SELF_PROTECTED');
  assert.equal(f.calls.some(call => call.sql.startsWith('DELETE FROM naruto_login.users')), false);
  await f.store.deleteUser(adminId, id);
  assert.deepEqual(f.calls.find(call => call.sql.startsWith('DELETE FROM naruto_login.users'))?.values, [id]);
  f.setMissing(true);
  for (const operation of [() => f.store.deleteUser(adminId, id), () => f.store.updateUser(adminId, id, changes, now)]) {
    await assert.rejects(operation(), error => error instanceof UserManagementError && error.code === 'NOT_FOUND');
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  }
});

test('扫码列表的总数与分页使用同一主任务条件，缺省日常兼容旧记录且不读取内部凭证', async t => {
  const f = fixture(t), start = new Date('2026-10-07T16:00:00Z'), end = new Date('2026-10-08T16:00:00Z');
  for (const mainTask of [undefined, 'daily', 'arena_weekly'] as const) {
    const result = await f.store.listDailyEvents(start, end, 20, 20, mainTask);
    assert.equal(result.total, 41); assert.equal(result.items[0].createdAt, now.toISOString());
    assert.doesNotMatch(JSON.stringify(result), /accessToken|private-token/);
    const query = f.calls.filter(call => call.sql.includes('FROM naruto_login.login_events e')).at(-1)!;
    const count = f.calls.filter(call => call.sql.startsWith('SELECT count(*)') && call.sql.includes('FROM naruto_login.login_events')).at(-1)!;
    assert.match(count.sql, /AND COALESCE\(user_options ->> 'mainTask', 'daily'\) = \$3/);
    assert.match(query.sql, /AND COALESCE\(e.user_options ->> 'mainTask', 'daily'\) = \$3/);
    assert.match(query.sql, /e.user_options AS "userOptions"/);
    assert.match(query.sql, /e.created_at >= \$1 AND e.created_at < \$2/);
    assert.doesNotMatch(query.sql, /access_token|request_id|password/);
    assert.deepEqual(count.values, [start, end, mainTask ?? 'daily']);
    assert.deepEqual(query.values, [start, end, mainTask ?? 'daily', 20, 20]);
    assert.match(query.sql, /LIMIT \$4 OFFSET \$5/);
  }
});

test('日常列表读取持久选项供首次完成判定，兼容旧记录且保留跳过秘境选择', async t => {
  const f = fixture(t);
  for (const [saved, expected] of [
    [undefined, { equipmentStamina: true, secretRealmMode: 'all' }],
    [{}, { equipmentStamina: true, secretRealmMode: 'all' }],
    [{ equipmentStamina: false, secretRealmOnce: true }, { equipmentStamina: false, secretRealmMode: 'once' }],
    [{ equipmentStamina: true, secretRealmMode: 'skip' }, { equipmentStamina: true, secretRealmMode: 'skip' }],
  ]) {
    f.setUserOptions(saved);
    const result = await f.store.listDailyEvents(now, new Date(now.getTime() + 300000), 0, 20);
    assert.deepEqual(result.items[0].userOptions, expected);
  }
  f.setUserOptions({ secretRealmMode: 'invalid' });
  await assert.rejects(f.store.listDailyEvents(now, new Date(now.getTime() + 300000), 0, 20), /Stored daily event user options are invalid/);
});

test('月榜总数与排名只统计日常申请，兼容旧记录并按北京日期去重且保留所有执行状态', async t => {
  const f = fixture(t), start = new Date('2026-09-30T16:00:00Z'), end = new Date('2026-10-31T16:00:00Z');
  for (const sort of ['requests', 'days'] as const) {
    const result = await f.store.listMonthlyStats(start, end, sort, 20, 20);
    assert.deepEqual(result, { items: [{ userId: id, username: 'Naruto', note: '', requestCount: 9, requestDays: 3, rank: 1 }], total: 41, totalRequests: 120 });
    const query = f.calls.filter(call => call.sql.startsWith('WITH stats AS')).at(-1)!;
    const count = f.calls.filter(call => call.sql.startsWith('SELECT count(DISTINCT user_id)')).at(-1)!;
    assert.match(count.sql, /AND COALESCE\(user_options ->> 'mainTask', 'daily'\) = 'daily'/);
    assert.match(query.sql, /AND COALESCE\(user_options ->> 'mainTask', 'daily'\) = 'daily'/);
    assert.match(query.sql, /count\(DISTINCT \(created_at AT TIME ZONE 'Asia\/Shanghai'\)::date\)/);
    assert.match(query.sql, /created_at >= \$1 AND created_at < \$2/);
    assert.match(query.sql, sort === 'days' ? /dense_rank\(\) OVER \(ORDER BY request_days DESC\)/ : /dense_rank\(\) OVER \(ORDER BY request_count DESC\)/);
    assert.match(query.sql, /s.user_id ASC LIMIT \$3 OFFSET \$4/);
    assert.doesNotMatch(query.sql, /status|access_token|password|dispatched_at/);
    assert.deepEqual(query.values, [start, end, 20, 20]);
  }
});
