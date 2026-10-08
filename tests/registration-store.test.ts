import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { ApplicationReviewError, PgAuthStore, UsernameTakenError,
  type ApplicationStatus, type RegistrationApplication, type StoredUser } from '../src/server/database.js';

interface Client { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>; release(destroy?: boolean): void }
const { Pool } = createRequire(new URL('../src/server/package.json', import.meta.url))('pg') as {
  Pool: { prototype: { connect(): Promise<Client>; query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> } };
};
const adminId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const otherId = '10000000-0000-4000-8000-000000000003';
const appId = '20000000-0000-4000-8000-000000000001';
const secondAppId = '20000000-0000-4000-8000-000000000002';
const now = new Date('2026-09-23T00:00:00.000Z');
const later = new Date(now.getTime() + 1000);
const password = 'registration-fixture-password';
type ApplicationRow = Omit<RegistrationApplication, 'createdAt' | 'reviewedAt'> & { createdAt: Date; reviewedAt: Date | null };
interface Operation { client: number; sql: string; values: unknown[] }

function user(id = userId): StoredUser {
  return { id, username: id === adminId ? 'Admin' : id === otherId ? 'Other' : 'Naruto',
    usernameKey: id === adminId ? 'admin' : id === otherId ? 'other' : 'naruto', password,
    isInvalid: false, isAdmin: true };
}

function fixture(t: TestContext) {
  const users = new Map<string, StoredUser>([[adminId, user(adminId)]]);
  const applications = new Map<string, ApplicationRow>();
  const operations: Operation[] = [];
  const undos = new Map<number, Array<() => void>>();
  const locks = new Map<string, Promise<void>>();
  const releases = new Map<number, () => void>();
  let sequence = 0;
  let failApplicationInsert = false;
  let failReviewUpdate = false;
  const undo = (client: number, restore: () => void) => undos.get(client)?.push(restore);

  async function query(client: number, text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    operations.push({ client, sql, values });
    if (sql === 'BEGIN') { undos.set(client, []); return { rows: [] }; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (sql === 'ROLLBACK') for (const restore of (undos.get(client) ?? []).reverse()) restore();
      undos.delete(client);
      releases.get(client)?.(); releases.delete(client);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO naruto_login.users')) {
      assert.match(sql, /VALUES \(\$1, \$2, \$3, \$4, true, false, \$5\)$/);
      const [id, username, usernameKey, storedPassword] = values as string[];
      if ([...users.values()].some(value => value.usernameKey === usernameKey)) {
        throw { code: '23505', constraint: 'naruto_login_users_username_key_key', message: 'private database detail' };
      }
      users.set(id, { id, username, usernameKey, password: storedPassword, isInvalid: true, isAdmin: false });
      undo(client, () => users.delete(id));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO naruto_login.registration_applications')) {
      if (failApplicationInsert) throw new Error('application insert failed');
      assert.match(sql, /VALUES \(\$1, \$2, 'pending', \$3\)$/);
      const [id, applicantId, createdAt] = values as [string, string, Date];
      if ([...applications.values()].some(value => value.userId === applicantId && value.status === 'pending')) throw new Error('pending uniqueness violation');
      applications.set(id, { id, userId: applicantId, username: users.get(applicantId)!.username,
        status: 'pending', createdAt, reviewedAt: null, reviewedBy: null, reason: null });
      undo(client, () => applications.delete(id));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT id FROM naruto_login.users WHERE id = $1 AND is_admin')) {
      assert.match(sql, /is_admin = true AND is_invalid = false FOR SHARE$/);
      const actor = users.get(String(values[0]));
      return { rows: actor?.isAdmin && !actor.isInvalid ? [{ id: actor.id }] : [] };
    }
    if (sql.startsWith('SELECT u.id, u.username, u.username_key')) {
      assert.match(sql, /u.is_invalid AS "isInvalid", u.is_admin AS "isAdmin"/);
      assert.match(sql, /ORDER BY a.created_at DESC, a.id DESC LIMIT 1/);
      const record = [...users.values()].find(value => value.usernameKey === values[0]);
      const latest = [...applications.values()].filter(value => value.userId === record?.id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
      return { rows: record ? [{ ...record, applicationStatus: latest?.status ?? null }] : [] };
    }
    if (sql.startsWith('SELECT id, username, is_admin')) {
      assert.equal(sql, 'SELECT id, username, is_admin AS "isAdmin" FROM naruto_login.users WHERE id = $1 AND is_invalid = false');
      assert.equal(values.length, 1);
      const record = users.get(String(values[0]));
      return { rows: record && !record.isInvalid ? [{ id: record.id, username: record.username, isAdmin: record.isAdmin }] : [] };
    }
    if (sql.startsWith('SELECT ') && sql.includes('FROM naruto_login.registration_applications a')) {
      assert.ok(!sql.includes('password'));
      if (sql.endsWith('FOR UPDATE OF a')) {
        const id = String(values[0]);
        const previous = locks.get(id) ?? Promise.resolve();
        let unlock!: () => void;
        locks.set(id, new Promise<void>(resolve => { unlock = resolve; }));
        await previous;
        releases.set(client, unlock);
      }
      if (sql.includes('WHERE a.id = $1')) {
        const record = applications.get(String(values[0]));
        return { rows: record ? [{ ...record }] : [] };
      }
      assert.match(sql, /WHERE \(\$1 = 'all' OR a.status = \$1\) ORDER BY a.created_at DESC, a.id DESC LIMIT \$2$/);
      return { rows: [...applications.values()].filter(value => values[0] === 'all' || value.status === values[0])
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, Number(values[1])).map(value => ({ ...value })) };
    }
    if (sql.startsWith('UPDATE naruto_login.users SET is_invalid')) {
      assert.equal(sql, 'UPDATE naruto_login.users SET is_invalid = $2 WHERE id = $1');
      const record = users.get(String(values[0]))!;
      const previous = { ...record };
      undo(client, () => users.set(record.id, previous));
      record.isInvalid = values[1] as boolean;
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE naruto_login.registration_applications')) {
      if (failReviewUpdate) throw new Error('review update failed');
      assert.match(sql, /WHERE id = \$1 AND status = 'pending'$/);
      const record = applications.get(String(values[0]))!;
      const previous = { ...record };
      undo(client, () => applications.set(record.id, previous));
      Object.assign(record, { status: values[1] as ApplicationStatus, reviewedAt: values[2] as Date, reviewedBy: values[3] as string, reason: values[4] as string | null });
      return { rows: [] };
    }
    return { rows: [] };
  }

  t.mock.method(Pool.prototype, 'connect', async () => {
    const client = ++sequence;
    return { query: (sql: string, values?: unknown[]) => query(client, sql, values), release() {
      assert.equal(releases.has(client), false); assert.equal(undos.has(client), false);
    } };
  });
  t.mock.method(Pool.prototype, 'query', (sql: string, values?: unknown[]) => query(0, sql, values));
  const store = new PgAuthStore('postgresql://fixture:fixture@127.0.0.1:5432/fixture');
  t.after(() => store.close());
  return { store, users, applications, operations,
    failInsert() { failApplicationInsert = true; }, failReview() { failReviewUpdate = true; } };
}

function reviewError(code: ApplicationReviewError['code']) {
  return (error: unknown) => { assert.ok(error instanceof ApplicationReviewError); assert.equal(error.code, code); return true; };
}

test('迁移保留旧账号有效性，新账号默认禁用，管理员默认 false 且无自动赋权', async t => {
  const { store, operations } = fixture(t);
  await store.initialize();
  const schema = operations.find(value => value.sql.includes('CREATE TABLE IF NOT EXISTS naruto_login.users'))!.sql;
  const add = schema.indexOf('ADD COLUMN IF NOT EXISTS is_invalid boolean NOT NULL DEFAULT false');
  const changeDefault = schema.indexOf('ALTER COLUMN is_invalid SET DEFAULT true');
  assert.ok(add >= 0 && changeDefault > add);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false/);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS \S+ ON naruto_login.registration_applications \(user_id\) WHERE status = 'pending'/);
  assert.match(schema, /reviewed_by uuid REFERENCES naruto_login.users\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(schema, /UPDATE naruto_login.users|is_admin[^;]*DEFAULT true|DROP |TRUNCATE /);
  for (const operation of operations) assert.doesNotMatch(operation.sql, /naruto_login\.sessions/);
});

test('注册强制创建禁用且非管理员的账号和 pending 申请，不访问会话表或公开密码', async t => {
  const { store, users, operations } = fixture(t);
  const application = await store.createRegistration(user(), appId, now);
  assert.deepEqual(application, { id: appId, userId, username: 'Naruto', status: 'pending',
    createdAt: now.toISOString(), reviewedAt: null, reviewedBy: null, reason: null });
  assert.equal(users.get(userId)?.isInvalid, true);
  assert.equal(users.get(userId)?.isAdmin, false);
  assert.equal(users.get(userId)?.password, password);
  assert.ok(!JSON.stringify(application).includes(password));
  for (const operation of operations) assert.doesNotMatch(operation.sql, /naruto_login\.sessions/);
  const insert = operations.find(value => value.sql.startsWith('INSERT INTO naruto_login.users'))!;
  assert.ok(!insert.sql.includes(password));
  assert.equal(insert.values[3], password);
});

test('重复用户名映射为 UsernameTakenError，申请插入失败会回滚新账号', async t => {
  const f = fixture(t);
  await f.store.createRegistration(user(), appId, now);
  await assert.rejects(f.store.createRegistration({ ...user(), id: otherId }, secondAppId, now), UsernameTakenError);
  assert.equal(f.applications.size, 1);
  f.failInsert();
  await assert.rejects(f.store.createRegistration(user(otherId), secondAppId, now), /application insert failed/);
  assert.equal(f.users.has(otherId), false);
  assert.equal(f.applications.size, 1);
  assert.equal(f.operations.at(-1)?.sql, 'ROLLBACK');
});

test('账号查询读取最新申请状态', async t => {
  const { store, applications } = fixture(t);
  await store.createRegistration(user(), appId, now);
  assert.equal((await store.findUser('naruto'))?.applicationStatus, 'pending');
  applications.set(secondAppId, { ...applications.get(appId)!, id: secondAppId, status: 'rejected', createdAt: later });
  assert.equal((await store.findUser('naruto'))?.applicationStatus, 'rejected');
  assert.equal((await store.findUser('admin'))?.applicationStatus, null);
});

test('按用户 ID 查询当前启用账号，禁用或删除即时返回 null，管理员角色变更即时生效', async t => {
  const { store, users } = fixture(t);
  await store.createRegistration(user(), appId, now);
  assert.equal(await store.findActiveUser(userId), null);
  users.get(userId)!.isInvalid = false;
  assert.deepEqual(await store.findActiveUser(userId), { id: userId, username: 'Naruto', isAdmin: false });
  users.get(userId)!.isAdmin = true;
  assert.equal((await store.findActiveUser(userId))?.isAdmin, true);
  users.get(userId)!.isAdmin = false;
  assert.equal((await store.findActiveUser(userId))?.isAdmin, false);
  users.get(userId)!.isInvalid = true;
  assert.equal(await store.findActiveUser(userId), null);
  users.get(userId)!.isInvalid = false;
  users.delete(userId);
  assert.equal(await store.findActiveUser(userId), null);
  assert.equal(await store.findActiveUser(otherId), null);
});

test('列表按状态和条数过滤，只返回公开申请字段并按新申请优先排序', async t => {
  const { store } = fixture(t);
  await store.createRegistration(user(), appId, now);
  await store.createRegistration(user(otherId), secondAppId, later);
  await store.reviewRegistration(appId, adminId, 'approved', null, later);
  assert.deepEqual((await store.listRegistrationApplications('pending', 10)).map(value => value.id), [secondAppId]);
  assert.deepEqual((await store.listRegistrationApplications('approved', 10)).map(value => value.id), [appId]);
  const all = await store.listRegistrationApplications('all', 1);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, secondAppId);
  assert.deepEqual(Object.keys(all[0]).sort(), ['createdAt', 'id', 'reason', 'reviewedAt', 'reviewedBy', 'status', 'userId', 'username']);
});

test('批准在锁定申请的事务内启用账号并记录审批人和时间，不授予管理员', async t => {
  const { store, users, operations } = fixture(t);
  await store.createRegistration(user(), appId, now);
  const result = await store.reviewRegistration(appId, adminId, 'approved', 'checked', later);
  assert.equal(result.status, 'approved');
  assert.equal(result.reviewedAt, later.toISOString());
  assert.equal(result.reviewedBy, adminId);
  assert.equal(users.get(userId)?.isInvalid, false);
  assert.equal(users.get(userId)?.isAdmin, false);
  const reviewClient = operations.find(value => value.sql.endsWith('FOR SHARE'))!.client;
  const steps = operations.filter(value => value.client === reviewClient);
  assert.equal(steps[0].sql, 'BEGIN');
  assert.equal(steps[1].sql, 'SELECT pg_advisory_xact_lock(19830527, 1179018069)');
  assert.match(steps[2].sql, /is_admin = true AND is_invalid = false FOR SHARE$/);
  assert.match(steps[3].sql, /FOR UPDATE OF a$/);
  assert.equal(steps.at(-1)?.sql, 'COMMIT');
});

test('普通账号、已禁用管理员和不存在的管理员均不能审批', async t => {
  const { store, users, applications } = fixture(t);
  await store.createRegistration(user(), appId, now);
  await assert.rejects(store.reviewRegistration(appId, userId, 'approved', null, later), reviewError('ADMIN_REQUIRED'));
  users.get(adminId)!.isInvalid = true;
  await assert.rejects(store.reviewRegistration(appId, adminId, 'approved', null, later), reviewError('ADMIN_REQUIRED'));
  await assert.rejects(store.reviewRegistration(appId, otherId, 'approved', null, later), reviewError('ADMIN_REQUIRED'));
  assert.equal(applications.get(appId)?.status, 'pending');
  assert.equal(users.get(userId)?.isInvalid, true);
});

test('找不到申请和重复审批分别返回受控业务错误，最终审批不可逆', async t => {
  const { store, users } = fixture(t);
  await assert.rejects(store.reviewRegistration(appId, adminId, 'approved', null, later), reviewError('NOT_FOUND'));
  await store.createRegistration(user(), appId, now);
  await store.reviewRegistration(appId, adminId, 'approved', null, later);
  await assert.rejects(store.reviewRegistration(appId, adminId, 'rejected', null, later), reviewError('ALREADY_REVIEWED'));
  assert.equal(users.get(userId)?.isInvalid, false);
});

test('拒绝申请后账号查询立即失效，不影响其他账号，原因使用 SQL 参数', async t => {
  const { store, users, operations } = fixture(t);
  await store.createRegistration(user(), appId, now);
  users.get(userId)!.isInvalid = false;
  const reason = "' ; DROP TABLE users; --";
  const result = await store.reviewRegistration(appId, adminId, 'rejected', reason, later);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, reason);
  assert.equal(users.get(userId)?.isInvalid, true);
  assert.equal(await store.findActiveUser(userId), null);
  assert.equal((await store.findActiveUser(adminId))?.isAdmin, true);
  for (const operation of operations) assert.doesNotMatch(operation.sql, /naruto_login\.sessions/);
  const update = operations.find(value => value.sql.startsWith('UPDATE naruto_login.registration_applications'))!;
  assert.ok(!update.sql.includes(reason));
  assert.equal(update.values[4], reason);
});

test('审批写入失败会回滚账号禁用，不留下半完成审批', async t => {
  const f = fixture(t);
  await f.store.createRegistration(user(), appId, now);
  f.users.get(userId)!.isInvalid = false;
  f.failReview();
  await assert.rejects(f.store.reviewRegistration(appId, adminId, 'rejected', null, later), /review update failed/);
  assert.equal(f.users.get(userId)?.isInvalid, false);
  assert.equal(f.applications.get(appId)?.status, 'pending');
  assert.equal(f.operations.at(-1)?.sql, 'ROLLBACK');
});

test('两个并发审批在申请行锁后只有一个成功，另一个识别为已审批', async t => {
  const { store, applications, users } = fixture(t);
  await store.createRegistration(user(), appId, now);
  const results = await Promise.allSettled([
    store.reviewRegistration(appId, adminId, 'approved', 'first', later),
    store.reviewRegistration(appId, adminId, 'rejected', 'second', later),
  ]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = results.find(value => value.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  reviewError('ALREADY_REVIEWED')(rejected.reason);
  assert.equal(applications.get(appId)?.status, 'approved');
  assert.equal(users.get(userId)?.isInvalid, false);
});
