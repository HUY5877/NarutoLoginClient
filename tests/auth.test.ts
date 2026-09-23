import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { AuthService, type User } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { ApplicationReviewError, PgAuthStore, UsernameTakenError, type ApplicationStatus,
  type AuthStore, type RegistrationApplication, type StoredSession, type StoredUser } from '../src/server/database.js';
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
  applications = new Map<string, RegistrationApplication>();
  initialized = 0;
  closed = 0;
  async initialize() { this.initialized++; }
  async createRegistration(user: StoredUser, applicationId: string, now: Date) {
    if (this.users.has(user.usernameKey)) throw new UsernameTakenError();
    this.users.set(user.usernameKey, { ...user });
    const application: RegistrationApplication = { id: applicationId, userId: user.id, username: user.username,
      status: 'pending', createdAt: now.toISOString(), reviewedAt: null, reviewedBy: null, reason: null };
    this.applications.set(applicationId, application);
    return { ...application };
  }
  async findUser(usernameKey: string) {
    const user = this.users.get(usernameKey);
    if (!user) return null;
    const application = [...this.applications.values()].find(value => value.userId === user.id);
    return { ...user, applicationStatus: application?.status };
  }
  async createSession(session: StoredSession) { this.sessions.set(session.tokenHash, { ...session }); }
  async findSessionUser(tokenHash: string, now: Date): Promise<User | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt.getTime() <= now.getTime()) return null;
    const user = [...this.users.values()].find(value => value.id === session.userId);
    return user && !user.isInvalid ? { id: user.id, username: user.username, isAdmin: user.isAdmin } : null;
  }
  async listRegistrationApplications(status: ApplicationStatus | 'all', limit: number) {
    return [...this.applications.values()].filter(application => status === 'all' || application.status === status).slice(0, limit).map(value => ({ ...value }));
  }
  async reviewRegistration(id: string, adminId: string, decision: 'approved' | 'rejected', reason: string | null, now: Date) {
    const admin = [...this.users.values()].find(user => user.id === adminId);
    if (!admin?.isAdmin || admin.isInvalid) throw new ApplicationReviewError('ADMIN_REQUIRED');
    const application = this.applications.get(id);
    if (!application) throw new ApplicationReviewError('NOT_FOUND');
    if (application.status !== 'pending') throw new ApplicationReviewError('ALREADY_REVIEWED');
    Object.assign(application, { status: decision, reason, reviewedBy: adminId, reviewedAt: now.toISOString() });
    const user = [...this.users.values()].find(value => value.id === application.userId)!;
    user.isInvalid = decision !== 'approved';
    return { ...application };
  }
  approve(usernameKey: string) {
    const user = this.users.get(usernameKey)!;
    user.isInvalid = false;
    const application = [...this.applications.values()].find(value => value.userId === user.id)!;
    application.status = 'approved';
  }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async close() { this.closed++; }
}

function fixture() {
  const store = new MemoryAuthStore();
  let now = start;
  return { store, service: new AuthService(config, { store, now: () => now }), setNow(value: number) { now = value; } };
}

function reviewer(store: MemoryAuthStore): User {
  const admin: StoredUser = { id: randomUUID(), username: 'Reviewer', usernameKey: 'reviewer', password,
    isAdmin: true, isInvalid: false };
  store.users.set(admin.usernameKey, admin);
  return { id: admin.id, username: admin.username, isAdmin: true };
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

test('注册保存待审申请和原始密码，不生成会话、不返回凭证且忽略提权字段', async () => {
  const { service, store } = fixture();
  const first = await service.register({ username: '  Naruto_01  ', password, isAdmin: true, isInvalid: false,
    applicationStatus: 'approved', status: 'approved' });
  const second = await service.register({ username: '佐助账号02', password });
  assert.deepEqual(Object.keys(first).sort(), ['application', 'message']);
  assert.equal(first.application.username, 'Naruto_01');
  assert.equal(first.application.status, 'pending');
  assert.equal(first.application.createdAt, new Date(start).toISOString());
  assert.equal(first.application.reviewedAt, null);
  assert.match(first.application.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first.application.userId, second.application.userId);
  assert.notEqual(first.application.id, first.application.userId);
  const rows = [...store.users.values()];
  for (const user of rows) {
    assert.equal(user.password, password);
    assert.equal(user.isInvalid, true);
    assert.equal(user.isAdmin, false);
  }
  assert.ok(!JSON.stringify(first).includes(password));
  assert.ok(!JSON.stringify(second).includes(password));
  assert.equal(rows[0].usernameKey, 'naruto_01');
  assert.equal(store.sessions.size, 0);
  assert.equal(store.applications.size, 2);
  await assert.rejects(service.login({ username: 'NARUTO_01', password }), errorIs(403, 'REGISTRATION_PENDING'));
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
  assert.equal(store.sessions.size, 0);
  assert.equal(store.applications.size, 1);
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
  for (const invalid of ['', 'a'.repeat(5), '😀'.repeat(5), 'a'.repeat(129), '😀'.repeat(129), 123, null]) {
    await assert.rejects(service.register({ username: 'Naruto', password: invalid }), errorIs(400, 'INVALID_PASSWORD'));
  }
  assert.equal(store.initialized, 0);
  assert.equal(store.users.size, 0);
});

test('密码支持 Unicode 且按字符校验长度，登录不归一化或裁剪密码', async () => {
  const { service, store } = fixture();
  const unicode = 'é'.repeat(6);
  await service.register({ username: 'Unicode', password: unicode });
  store.approve('unicode');
  await service.login({ username: 'Unicode', password: unicode });
  await assert.rejects(service.login({ username: 'Unicode', password: 'e\u0301'.repeat(6) }), errorIs(401, 'INVALID_CREDENTIALS'));
  await service.register({ username: 'Emoji', password: '😀'.repeat(6) });
  store.approve('emoji');
  await service.login({ username: 'Emoji', password: '😀'.repeat(6) });
  await service.register({ username: 'Spaces', password: ' padded password ' });
  store.approve('spaces');
  await assert.rejects(service.login({ username: 'Spaces', password: 'padded password' }), errorIs(401, 'INVALID_CREDENTIALS'));
  await service.register({ username: 'a'.repeat(24), password: '😀'.repeat(128) });
});

test('用户名不存在和密码错误返回同一种认证失败', async () => {
  const { service, store } = fixture();
  await service.register({ username: 'Naruto', password });
  const failure = errorIs(401, 'INVALID_CREDENTIALS', '用户名或密码错误。');
  await assert.rejects(service.login({ username: 'Unknown', password }), failure);
  await assert.rejects(service.login({ username: 'Naruto', password: 'wrong-password' }), failure);
  assert.equal(store.sessions.size, 0);
});

test('先验证密码再返回待审核、拒绝或停用状态，禁用账户不能生成会话', async () => {
  const { service, store } = fixture();
  const registered = await service.register({ username: 'Naruto', password });
  const application = store.applications.get(registered.application.id)!;
  for (const [status, code] of [['pending', 'REGISTRATION_PENDING'], ['rejected', 'REGISTRATION_REJECTED'], ['approved', 'ACCOUNT_DISABLED']] as const) {
    application.status = status;
    await assert.rejects(service.login({ username: 'Naruto', password: 'wrong-password' }), errorIs(401, 'INVALID_CREDENTIALS'));
    await assert.rejects(service.login({ username: 'Naruto', password }), errorIs(403, code));
  }
  store.applications.clear();
  await assert.rejects(service.login({ username: 'Naruto', password }), errorIs(403, 'ACCOUNT_DISABLED'));
  assert.equal(store.sessions.size, 0);
});

test('管理员批准后账号才可登录，审核响应保留操作者和时间且不暴露密码', async () => {
  const { service, store } = fixture();
  const registered = await service.register({ username: 'Naruto', password });
  const admin = reviewer(store);
  const reviewed = await service.reviewApplication(admin, registered.application.id, { decision: 'approved', reason: ' 已确认 ', isAdmin: true });
  assert.deepEqual(reviewed.application, { ...registered.application, status: 'approved', reason: '已确认',
    reviewedBy: admin.id, reviewedAt: new Date(start).toISOString() });
  assert.equal(store.sessions.size, 0);
  const loggedIn = await service.login({ username: 'NARUTO', password });
  assert.deepEqual(loggedIn.user, { id: registered.application.userId, username: 'Naruto', isAdmin: false });
  assert.deepEqual(Object.keys(loggedIn.user).sort(), ['id', 'isAdmin', 'username']);
  assert.equal(store.users.get('naruto')?.isInvalid, false);
  assert.equal(store.users.get('naruto')?.isAdmin, false);
  assert.ok(!JSON.stringify(reviewed).includes(password));
});

test('拒绝申请保持账号禁用且不生成会话，允许空备注及最多200个Unicode字符', async () => {
  const { service, store } = fixture();
  const admin = reviewer(store);
  for (const [index, reason] of [undefined, null, '', '😀'.repeat(200)].entries()) {
    const registered = await service.register({ username: `Rejected${index}`, password });
    const result = await service.reviewApplication(admin, registered.application.id, { decision: 'rejected', reason });
    assert.equal(result.application.reason, reason || null);
    assert.equal(result.application.status, 'rejected');
    await assert.rejects(service.login({ username: `Rejected${index}`, password }), errorIs(403, 'REGISTRATION_REJECTED'));
  }
  assert.equal(store.sessions.size, 0);
});

test('非管理员不能列出或审核申请，权限校验先于数据库访问', async () => {
  const { service, store } = fixture();
  const ordinary: User = { id: randomUUID(), username: 'Ordinary', isAdmin: false };
  await assert.rejects(service.listApplications(ordinary, 'all'), errorIs(403, 'ADMIN_REQUIRED'));
  await assert.rejects(service.reviewApplication(ordinary, randomUUID(), { decision: 'approved' }), errorIs(403, 'ADMIN_REQUIRED'));
  await assert.rejects(service.reviewApplication({ ...ordinary, isAdmin: 'true' } as unknown as User, 'invalid', {}), errorIs(403, 'ADMIN_REQUIRED'));
  assert.equal(store.initialized, 0);
});

test('管理员查询接受已定义状态、缺省待审核，并限制单次查询数量', async t => {
  const { service, store } = fixture();
  const admin = reviewer(store);
  const first = await service.register({ username: 'PendingUser', password });
  const second = await service.register({ username: 'ApprovedUser', password });
  await service.reviewApplication(admin, second.application.id, { decision: 'approved' });
  assert.deepEqual(await service.listApplications(admin, undefined), { applications: [first.application] });
  assert.equal((await service.listApplications(admin, 'approved')).applications[0].id, second.application.id);
  assert.equal((await service.listApplications(admin, 'all')).applications.length, 2);
  assert.deepEqual(await service.listApplications(admin, 'rejected'), { applications: [] });
  t.mock.method(store, 'listRegistrationApplications', async (status: ApplicationStatus | 'all', limit: number) => {
    assert.equal(status, 'pending'); assert.equal(limit, 100); return [];
  });
  await service.listApplications(admin, 'pending');
});

test('审核编号、决定、备注和查询状态在访问数据库前校验', async () => {
  const { service, store } = fixture();
  const admin = reviewer(store);
  for (const status of [null, '', 'unknown', 1, []]) {
    await assert.rejects(service.listApplications(admin, status), errorIs(400, 'INVALID_APPLICATION_STATUS'));
  }
  for (const value of ['', 'bad-id', '123e4567-e89b-12d3-a456-426614174000']) {
    await assert.rejects(service.reviewApplication(admin, value, { decision: 'approved' }), errorIs(400, 'INVALID_APPLICATION_ID'));
  }
  for (const body of [null, [], 'approved', {}, { decision: 'pending' }, { decision: true }]) {
    await assert.rejects(service.reviewApplication(admin, randomUUID(), body), errorIs(400, 'INVALID_REVIEW_DECISION'));
  }
  for (const reason of ['字'.repeat(201), '😀'.repeat(201), 123, {}, []]) {
    await assert.rejects(service.reviewApplication(admin, randomUUID(), { decision: 'approved', reason }), errorIs(400, 'INVALID_REVIEW_REASON'));
  }
  assert.equal(store.initialized, 0);
});

test('审核不存在、已审核和管理员权限已撤销分别映射为404、409和403', async () => {
  const { service, store } = fixture();
  const admin = reviewer(store);
  const result = await service.register({ username: 'Naruto', password });
  await assert.rejects(service.reviewApplication(admin, randomUUID(), { decision: 'approved' }), errorIs(404, 'APPLICATION_NOT_FOUND'));
  await service.reviewApplication(admin, result.application.id, { decision: 'approved' });
  await assert.rejects(service.reviewApplication(admin, result.application.id, { decision: 'rejected' }), errorIs(409, 'APPLICATION_ALREADY_REVIEWED'));
  store.users.get('reviewer')!.isInvalid = true;
  await assert.rejects(service.reviewApplication(admin, result.application.id, { decision: 'approved' }), errorIs(403, 'ADMIN_REQUIRED'));
});

test('已登录会话在账号禁用后立即失效，公开管理员标志读取当前值', async () => {
  const { service, store } = fixture();
  await service.register({ username: 'Naruto', password });
  store.approve('naruto');
  const loggedIn = await service.login({ username: 'Naruto', password });
  const stored = store.users.get('naruto')!;
  assert.equal((await service.getUser(loggedIn.token))?.isAdmin, false);
  stored.isAdmin = true;
  assert.equal((await service.getUser(loggedIn.token))?.isAdmin, true);
  stored.isInvalid = true;
  assert.equal(await service.getUser(loggedIn.token), null);
});

test('审核与申请列表数据库错误统一脱敏', async t => {
  const { service, store } = fixture();
  const admin = reviewer(store);
  const fail = async (): Promise<never> => { throw new Error('postgres://user:secret@host/database private SQL'); };
  t.mock.method(store, 'reviewRegistration', fail);
  t.mock.method(store, 'listRegistrationApplications', fail);
  const sanitized = errorIs(503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。');
  await assert.rejects(service.reviewApplication(admin, randomUUID(), { decision: 'approved' }), sanitized);
  await assert.rejects(service.listApplications(admin, 'all'), sanitized);
});

test('每次认证生成独立的 7 天会话，数据库只保存令牌的 SHA-256 摘要', async () => {
  const { service, store, setNow } = fixture();
  await service.register({ username: 'Naruto', password });
  store.approve('naruto');
  const registered = await service.login({ username: 'Naruto', password });
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
  await service.register({ username: 'Naruto', password });
  store.approve('naruto');
  const first = await service.login({ username: 'Naruto', password });
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
  await service.register({ username: 'Naruto', password });
  store.approve('naruto');
  const registered = await service.login({ username: 'Naruto', password });
  const fail = async () => { throw new Error('SQL secret-password postgres://user:password@host/database'); };
  const sanitized = errorIs(503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。');
  t.mock.method(store, 'createRegistration', fail);
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

test('Postgres 注册在申请写入失败时回滚用户写入并丢弃事务连接', async t => {
  const operations: Array<{ sql: string; values?: unknown[] }> = [];
  const applicationFailure = new Error('application insert failed');
  let destroyed: boolean | undefined;
  const client: MockPgClient = {
    async query(sql, values) {
      operations.push({ sql, values });
      if (sql.startsWith('INSERT INTO naruto_login.registration_applications')) throw applicationFailure;
      return { rows: [] };
    },
    release(value) { destroyed = value; },
  };
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const store = new PgAuthStore(config.databaseUrl!);
  const user: StoredUser = { id: '123e4567-e89b-42d3-a456-426614174000', username: 'Naruto', usernameKey: 'naruto', password,
    isInvalid: true, isAdmin: false };
  try {
    await store.initialize();
    operations.length = 0;
    destroyed = undefined;
    await assert.rejects(store.createRegistration(user, randomUUID(), new Date(start)), error => error === applicationFailure);
    assert.equal(operations[0].sql, 'BEGIN');
    assert.equal(operations.at(-1)?.sql, 'ROLLBACK');
    assert.equal(operations.some(operation => operation.sql === 'COMMIT'), false);
    assert.deepEqual(operations.find(operation => operation.sql.startsWith('INSERT INTO naruto_login.users'))?.values,
      [user.id, user.username, user.usernameKey, password, new Date(start)]);
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
  const user: StoredUser = { id: '123e4567-e89b-42d3-a456-426614174000', username: 'Naruto', usernameKey: 'naruto', password,
    isInvalid: true, isAdmin: false };
  try {
    await assert.rejects(store.createRegistration(user, randomUUID(), new Date(start)), UsernameTakenError);
    constraint = 'users_pkey';
    await assert.rejects(store.createRegistration(user, randomUUID(), new Date(start)), error => {
      assert.ok(!(error instanceof UsernameTakenError));
      assert.equal((error as { code: string }).code, '23505');
      return true;
    });
  } finally { await store.close(); }
});
