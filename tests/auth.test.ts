import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { AuthService, type User } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { PgAuthStore, UsernameTakenError, type AuthStore, type StoredSession, type StoredUser } from '../src/server/database.js';
import { ApiError } from '../src/server/errors.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture' });
const start = Date.parse('2026-09-23T00:00:00.000Z');
const password = '火影账号密码🔐2026';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
interface MockPgClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean): void;
}
const { Pool } = createRequire(new URL('../src/server/package.json', import.meta.url))('pg') as {
  Pool: { prototype: { connect(): Promise<MockPgClient> } };
};

class MemoryAuthStore implements AuthStore {
  users = new Map<string, StoredUser>();
  sessions = new Map<string, StoredSession>();
  initialized = 0;
  closed = 0;
  async initialize() { this.initialized++; }
  async createUserAndSession(user: StoredUser, session: StoredSession) {
    if (this.users.has(user.usernameKey)) throw new UsernameTakenError();
    this.users.set(user.usernameKey, { ...user });
    this.sessions.set(session.tokenHash, { ...session });
  }
  async findUser(usernameKey: string) { return this.users.get(usernameKey) ?? null; }
  async createSession(session: StoredSession) { this.sessions.set(session.tokenHash, { ...session }); }
  async findSessionUser(tokenHash: string, now: Date): Promise<User | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt.getTime() <= now.getTime()) return null;
    const user = [...this.users.values()].find(value => value.id === session.userId);
    return user ? { id: user.id, username: user.username } : null;
  }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async close() { this.closed++; }
}

function fixture() {
  const store = new MemoryAuthStore();
  let now = start;
  return { store, service: new AuthService(config, { store, now: () => now }), setNow(value: number) { now = value; } };
}

function errorIs(status: number, code: string, message?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (message) assert.equal(error.message, message);
    return true;
  };
}

test('注册按要求保存原始密码，公开用户不包含密码字段', async () => {
  const { service, store } = fixture();
  const first = await service.register({ username: '  Naruto_01  ', password });
  const second = await service.register({ username: '佐助账号02', password });
  assert.deepEqual(Object.keys(first.user).sort(), ['id', 'username']);
  assert.equal(first.user.username, 'Naruto_01');
  assert.match(first.user.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first.user.id, second.user.id);
  const rows = [...store.users.values()];
  for (const user of rows) assert.equal(user.password, password);
  assert.ok(!JSON.stringify(first).includes(password));
  assert.ok(!JSON.stringify(second).includes(password));
  assert.equal(rows[0].usernameKey, 'naruto_01');
  assert.deepEqual((await service.login({ username: 'NARUTO_01', password })).user, first.user);
});

test('并发注册通过存储唯一约束拒绝大小写不同的重复用户名', async () => {
  const { service, store } = fixture();
  const result = await Promise.allSettled([
    service.register({ username: 'Naruto', password }),
    service.register({ username: 'nARUTO', password }),
  ]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  const failed = result.find(value => value.status === 'rejected');
  assert.ok(failed && failed.status === 'rejected');
  errorIs(409, 'USERNAME_TAKEN')(failed.reason);
  assert.equal(store.users.size, 1);
  assert.equal(store.sessions.size, 1);
  assert.equal(store.initialized, 1);
});

test('用户名、密码和请求结构先校验，非法输入不访问数据库', async () => {
  const { service, store } = fixture();
  for (const body of [null, [], 'username', 123]) {
    await assert.rejects(service.register(body), errorIs(400, 'INVALID_CREDENTIALS'));
  }
  for (const username of ['', 'ab', '用', 'a'.repeat(25), 'user name', '名字！', 'admin@example.com', "admin'--", '用户😀名']) {
    await assert.rejects(service.register({ username, password }), errorIs(400, 'INVALID_USERNAME'));
  }
  for (const invalid of ['', 'a'.repeat(7), '😀'.repeat(7), 'a'.repeat(129), '😀'.repeat(129), 123, null]) {
    await assert.rejects(service.register({ username: 'Naruto', password: invalid }), errorIs(400, 'INVALID_PASSWORD'));
  }
  assert.equal(store.initialized, 0);
  assert.equal(store.users.size, 0);
});

test('密码支持 Unicode 且按字符校验长度，登录不归一化或裁剪密码', async () => {
  const { service } = fixture();
  const unicode = 'é'.repeat(8);
  await service.register({ username: 'Unicode', password: unicode });
  await service.login({ username: 'Unicode', password: unicode });
  await assert.rejects(service.login({ username: 'Unicode', password: 'e\u0301'.repeat(8) }), errorIs(401, 'INVALID_CREDENTIALS'));
  await service.register({ username: 'Emoji', password: '😀'.repeat(8) });
  await service.login({ username: 'Emoji', password: '😀'.repeat(8) });
  await service.register({ username: 'Spaces', password: ' padded password ' });
  await assert.rejects(service.login({ username: 'Spaces', password: 'padded password' }), errorIs(401, 'INVALID_CREDENTIALS'));
  await service.register({ username: 'a'.repeat(24), password: '😀'.repeat(128) });
});

test('用户名不存在和密码错误返回同一种认证失败', async () => {
  const { service, store } = fixture();
  await service.register({ username: 'Naruto', password });
  const failure = errorIs(401, 'INVALID_CREDENTIALS', '用户名或密码错误。');
  await assert.rejects(service.login({ username: 'Unknown', password }), failure);
  await assert.rejects(service.login({ username: 'Naruto', password: 'wrong-password' }), failure);
  assert.equal(store.sessions.size, 1);
});

test('每次认证生成独立的 7 天会话，数据库只保存令牌的 SHA-256 摘要', async () => {
  const { service, store, setNow } = fixture();
  const registered = await service.register({ username: 'Naruto', password });
  const loggedIn = await service.login({ username: 'naruto', password });
  assert.match(registered.token, /^[a-f0-9]{64}$/);
  assert.match(loggedIn.token, /^[a-f0-9]{64}$/);
  assert.notEqual(registered.token, loggedIn.token);
  assert.equal(registered.expiresAt.getTime() - start, 7 * 24 * 60 * 60 * 1000);
  assert.equal(store.sessions.size, 2);
  for (const result of [registered, loggedIn]) {
    assert.equal(store.sessions.has(result.token), false);
    assert.deepEqual(store.sessions.get(digest(result.token)), { tokenHash: digest(result.token), userId: registered.user.id, expiresAt: result.expiresAt });
    assert.ok(!JSON.stringify([...store.sessions.values()]).includes(result.token));
    assert.deepEqual(await service.getUser(result.token), registered.user);
  }
  assert.equal(await service.getUser('f'.repeat(64)), null);
  assert.equal(await service.getUser(digest(registered.token)), null);
  setNow(registered.expiresAt.getTime() - 1);
  assert.deepEqual(await service.getUser(registered.token), registered.user);
  setNow(registered.expiresAt.getTime());
  assert.equal(await service.getUser(registered.token), null);
});

test('会话可跨服务实例恢复，登出立即吊销指定会话而不影响其他会话', async () => {
  const { service, store } = fixture();
  const first = await service.register({ username: 'Naruto', password });
  const second = await service.login({ username: 'Naruto', password });
  const restarted = new AuthService(config, { store, now: () => start });
  assert.deepEqual(await restarted.getUser(first.token), first.user);
  await restarted.logout(first.token);
  assert.equal(await service.getUser(first.token), null);
  assert.deepEqual(await service.getUser(second.token), first.user);
  assert.equal(store.sessions.size, 1);
  await service.logout(first.token);
  await restarted.close();
  assert.equal(store.closed, 1);
});

test('缺少数据库配置时认证返回受控 503，匿名或无效凭据读取不需要数据库', async () => {
  const service = new AuthService(loadConfig({}));
  for (const token of [undefined, '', 'not-a-token', 'A'.repeat(64)]) {
    assert.equal(await service.getUser(token), null);
    await service.logout(token);
  }
  const missing = errorIs(503, 'DATABASE_NOT_CONFIGURED');
  await assert.rejects(service.initialize(), missing);
  await assert.rejects(service.register({ username: 'Naruto', password }), missing);
  await assert.rejects(service.login({ username: 'Naruto', password }), missing);
  await assert.rejects(service.getUser('a'.repeat(64)), missing);
  await assert.rejects(service.logout('a'.repeat(64)), missing);
  await service.close();
});

test('初始化在并发调用时仅执行一次，失败脱敏后允许下次重试', async t => {
  const { service, store } = fixture();
  let attempts = 0;
  t.mock.method(store, 'initialize', async () => {
    attempts++;
    if (attempts === 1) throw new Error('postgresql://private-user:private-password@private-host');
  });
  const results = await Promise.allSettled([service.initialize(), service.initialize()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') errorIs(503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。')(result.reason);
  }
  assert.equal(attempts, 1);
  await Promise.all([service.initialize(), service.initialize()]);
  await service.initialize();
  assert.equal(attempts, 2);
});

test('数据库读写异常不泄露连接信息、SQL、密码或内部错误', async t => {
  const { service, store } = fixture();
  const registered = await service.register({ username: 'Naruto', password });
  const fail = async () => { throw new Error('SQL secret-password postgres://user:password@host/database'); };
  const sanitized = errorIs(503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。');
  t.mock.method(store, 'createUserAndSession', fail);
  await assert.rejects(service.register({ username: 'OtherUser', password }), sanitized);
  t.mock.method(store, 'createSession', fail);
  await assert.rejects(service.login({ username: 'Naruto', password }), sanitized);
  t.mock.method(store, 'findUser', fail);
  await assert.rejects(service.login({ username: 'Naruto', password }), sanitized);
  t.mock.method(store, 'findSessionUser', fail);
  await assert.rejects(service.getUser(registered.token), sanitized);
  t.mock.method(store, 'deleteSession', fail);
  await assert.rejects(service.logout(registered.token), sanitized);
  assert.equal(store.sessions.size, 1);
});

test('数据库连接地址可省略，仅接受 PostgreSQL URL 且配置错误不回显地址', () => {
  assert.equal(loadConfig({}).databaseUrl, undefined);
  assert.equal(loadConfig({ DATABASE_URL: '  ' }).databaseUrl, undefined);
  for (const value of ['not-a-url', 'https://secret:credential@host/database', 'postgresql://host', 'postgresql://host/db#secret']) {
    assert.throws(() => loadConfig({ DATABASE_URL: value }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DATABASE_URL/);
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://user:password@host:5432/db?sslmode=require' }).databaseUrl,
    'postgres://user:password@host:5432/db?sslmode=require');
});

test('Postgres 注册在会话写入失败时回滚用户写入并丢弃事务连接', async t => {
  const operations: Array<{ sql: string; values?: unknown[] }> = [];
  const sessionFailure = new Error('session insert failed');
  let destroyed: boolean | undefined;
  const client: MockPgClient = {
    async query(sql, values) {
      operations.push({ sql, values });
      if (sql.startsWith('INSERT INTO naruto_login.sessions')) throw sessionFailure;
      return { rows: [] };
    },
    release(value) { destroyed = value; },
  };
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const store = new PgAuthStore(config.databaseUrl!);
  const user: StoredUser = { id: '123e4567-e89b-42d3-a456-426614174000', username: 'Naruto', usernameKey: 'naruto', password };
  try {
    await assert.rejects(store.createUserAndSession(user, { tokenHash: 'a'.repeat(64), userId: user.id, expiresAt: new Date(start) }), error => error === sessionFailure);
    assert.equal(operations[0].sql, 'BEGIN');
    assert.equal(operations.at(-1)?.sql, 'ROLLBACK');
    assert.equal(operations.some(operation => operation.sql === 'COMMIT'), false);
    assert.deepEqual(operations.find(operation => operation.sql.startsWith('INSERT INTO naruto_login.users'))?.values,
      [user.id, user.username, user.usernameKey, password]);
    assert.equal(destroyed, true);
  } finally { await store.close(); }
});

test('Postgres 只把用户名唯一约束冲突识别为重复用户名', async t => {
  let constraint = 'naruto_login_users_username_key_key';
  const client: MockPgClient = {
    async query(sql) {
      if (sql.startsWith('INSERT')) throw { code: '23505', constraint, message: 'private database detail' };
      return { rows: [] };
    },
    release() {},
  };
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const store = new PgAuthStore(config.databaseUrl!);
  const user: StoredUser = { id: '123e4567-e89b-42d3-a456-426614174000', username: 'Naruto', usernameKey: 'naruto', password };
  const session: StoredSession = { tokenHash: 'a'.repeat(64), userId: user.id, expiresAt: new Date(start) };
  try {
    await assert.rejects(store.createUserAndSession(user, session), UsernameTakenError);
    constraint = 'users_pkey';
    await assert.rejects(store.createUserAndSession(user, session), error => {
      assert.ok(!(error instanceof UsernameTakenError));
      assert.equal((error as { code: string }).code, '23505');
      return true;
    });
  } finally { await store.close(); }
});
