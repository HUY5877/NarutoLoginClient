import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { McpQqBindingService, PgMcpQqBindingStore } from '../src/server/mcp/mcp-qq-bindings.js';
import { PgQqRobotBindingStore } from '../src/server/mcp/qq-robot-bindings.js';
import { ApiError } from '../src/server/errors.js';

const { PGlite } = createRequire(new URL('../src/server/package.json', import.meta.url))('@electric-sql/pglite') as
  typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
const userId = 'a0000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const disabledId = '10000000-0000-4000-8000-000000000003';
const missingId = '10000000-0000-4000-8000-000000000004';
const start = Date.parse('2026-11-06T00:00:00Z');
const config = { databaseUrl: 'postgresql://fixture:fixture@db.invalid/fixture', timeoutMs: 5000, hyrzPublicUrl: 'https://hyrz.example' };
const status = (value: number) => (error: unknown) => error instanceof ApiError && error.status === value;
const tokenOf = (value: { bindingUrl: string }) => new URL(value.bindingUrl).hash.slice('#mcp-bind='.length);

test('新机器人所有操作与旧数字和OpenID绑定完全隔离', async t => {
  const { service, db } = await fixture(t);
  const confirmed = tokenOf(await service.create('111'));
  await service.confirm(userId, confirmed);
  await service.create('222');
  const snapshot = async () => {
    const tables = ['qq_number_bindings', 'qq_number_binding_requests', 'qq_bindings', 'qq_binding_challenges'];
    return Promise.all(tables.map(async table => (await db.query<Record<string, unknown>>(`SELECT * FROM naruto_login.${table}`)).rows));
  };
  const old = await snapshot();
  await assert.rejects(service.resolveRobot('111'), status(404));
  assert.equal((await service.getStatus(userId)).binding, null, '状态不回退读取旧关联');
  assert.deepEqual(await snapshot(), old);
  const robot = await service.bind('111');
  assert.notEqual(robot.userId, userId, '新机器人不能复用旧映射');
  assert.deepEqual(await snapshot(), old, '无代码绑定不得撤销旧链接或修改旧映射');
  const first = await service.createChallenge(otherId);
  assert.deepEqual(await snapshot(), old);
  const current = await service.createChallenge(otherId);
  assert.deepEqual(await snapshot(), old);
  await assert.rejects(service.bind('111', first.code), status(409));
  assert.deepEqual(await snapshot(), old);
  await service.bind('111', current.code);
  assert.deepEqual(await snapshot(), old, '有码兑换转移新映射，不修改旧记录');
  await service.bind('111', current.code);
  assert.deepEqual(await snapshot(), old);
  assert.deepEqual(await service.resolveRobot('111'), { qq: '111', userId: otherId });
  assert.deepEqual(await snapshot(), old);
  await service.getStatus(otherId);
  assert.deepEqual(await snapshot(), old);
  await service.unbindRobot(otherId);
  assert.deepEqual(await snapshot(), old);
  await assert.rejects(service.bind('111', current.code), status(409));
  assert.deepEqual(await snapshot(), old);
  assert.deepEqual(await service.resolve('111'), { qq: '111', userId });
  assert.equal((await service.preview(confirmed)).qq, '111');
});

test('只使用新机器人时不创建任何旧数字绑定表，初始化用户只执行一次', async t => {
  const { service, db } = await fixture(t);
  await service.getStatus(userId);
  await service.bind('111');
  await service.createChallenge(userId);
  assert.deepEqual((await db.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
    WHERE schemaname = 'naruto_login' AND tablename LIKE 'qq_number_%'`)).rows, []);
  assert.equal((await db.query(`SELECT * FROM naruto_login.qq_robot_bindings`)).rows.length, 1);
});

test('网站随机码只保存摘要、按账号隔离，重发与五分钟边界撤销旧码', async t => {
  const { service, db, advance } = await fixture(t);
  assert.deepEqual(await service.getStatus(userId), { enabled: true, binding: null, challenge: null });
  const first = await service.createChallenge(userId);
  assert.match(first.code, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(Date.parse(first.expiresAt), start + 300000);
  assert.deepEqual((await service.getStatus(userId)).challenge, { id: first.id, expiresAt: first.expiresAt });
  assert.equal((await service.getStatus(otherId)).challenge, null);
  const rows = (await db.query<Record<string, unknown>>('SELECT * FROM naruto_login.qq_robot_binding_codes')).rows;
  assert.equal(rows[0].code_hash, createHash('sha256').update(first.code).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(first.code));
  const next = await service.createChallenge(userId);
  assert.notEqual(first.code, next.code);
  await assert.rejects(service.bind('111', first.code), status(409));
  advance(300000);
  assert.equal((await service.getStatus(userId)).challenge, null);
  await assert.rejects(service.bind('111', next.code), status(409));
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
});

test('网站码原子迁移新机器人自动账号与目标QQ，保留用户旧链接并撤销双方旧码', async t => {
  const { service, db, advance } = await fixture(t);
  const original = await service.bind('111');
  const sourceCode = await service.createChallenge(original.userId);
  const targetLink = tokenOf(await service.create('222'));
  await service.confirm(userId, targetLink);
  await service.bind('222', (await service.createChallenge(userId)).code);
  const pendingIncomingLink = tokenOf(await service.create('111'));
  const destination = await service.createChallenge(userId);
  advance(1000);
  assert.deepEqual(await service.bind('111', destination.code), { qq: '111', userId });
  assert.deepEqual(await service.bind('111', destination.code), { qq: '111', userId });
  assert.deepEqual(await service.getStatus(userId), { enabled: true,
    binding: { qq: '111', boundAt: new Date(start + 1000).toISOString() }, challenge: null });
  assert.equal((await service.getStatus(original.userId)).binding, null);
  await assert.rejects(service.resolveRobot('222'), status(404));
  await assert.rejects(service.bind('333', sourceCode.code), status(409));
  assert.equal((await service.preview(targetLink)).qq, '222');
  assert.equal((await service.preview(pendingIncomingLink)).qq, '111');
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 4);
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows,
    [{ user_id: userId, member_openid: '  arbitrary OpenID / 原样  ' }]);
});

test('同码不同QQ竞争只成功一方，同QQ重试幂等，解绑和新码使成功码不可重放', async t => {
  const { service, db } = await fixture(t);
  const code = await service.createChallenge(userId);
  const results = await Promise.allSettled(['111', '222'].map(qq => service.bind(qq, code.code)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ qq: string; userId: string }>;
  assert.deepEqual(await service.bind(winner.value.qq, code.code), winner.value);
  await service.unbindRobot(userId);
  await assert.rejects(service.bind(winner.value.qq, code.code), status(409));
  const next = await service.createChallenge(userId);
  await service.bind(winner.value.qq, next.code);
  await service.createChallenge(userId);
  await assert.rejects(service.bind(winner.value.qq, next.code), status(409));
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
});

test('QQ转出再转回即使时钟相同也不能重放原成功码', async t => {
  const { service } = await fixture(t);
  const first = await service.createChallenge(userId);
  await service.bind('111', first.code);
  const second = await service.createChallenge(otherId);
  await service.bind('111', second.code);
  const third = await service.createChallenge(userId);
  await service.bind('111', third.code);
  await assert.rejects(service.bind('111', first.code), status(409));
  await assert.rejects(service.bind('111', second.code), status(409));
});

test('非法网站码不降级注册，大小写敏感，停用或不存在的目标不能发码查询兑换', async t => {
  const { service, db } = await fixture(t);
  const code = await service.createChallenge(userId);
  for (const invalid of ['', 'bad', ' '.repeat(24), code.code + '\n', 'A'.repeat(24)]) {
    await assert.rejects(service.bind('111', invalid));
  }
  const changedCase = [...code.code].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join('');
  if (changedCase !== code.code) await assert.rejects(service.bind('111', changedCase), status(409));
  for (const id of [disabledId, missingId]) {
    await assert.rejects(service.createChallenge(id), status(403));
    await assert.rejects(service.getStatus(id), status(403));
  }
  await db.query('UPDATE naruto_login.users SET is_invalid = true WHERE id = $1', [userId]);
  await assert.rejects(service.bind('111', code.code), status(403));
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_robot_bindings')).rows.length, 0);
});

test('码兑换数据库失败回滚新关联及代码消耗，旧链接保持不变', async t => {
  const { service, db } = await fixture(t);
  const old = await service.bind('111');
  const oldLink = tokenOf(await service.create('222'));
  await service.confirm(userId, oldLink);
  await service.bind('222', (await service.createChallenge(userId)).code);
  const code = await service.createChallenge(userId);
  await db.exec("ALTER TABLE naruto_login.qq_robot_bindings ADD CONSTRAINT fail_transfer CHECK (qq_number <> '111' OR user_id <> 'a0000000-0000-4000-8000-000000000001')");
  await assert.rejects(service.bind('111', code.code), status(503));
  assert.deepEqual(await service.resolveRobot('111'), old);
  assert.deepEqual(await service.resolveRobot('222'), { qq: '222', userId });
  assert.equal((await service.getStatus(userId)).challenge?.id, code.id);
  assert.equal((await service.preview(oldLink)).qq, '222');
  await db.exec('ALTER TABLE naruto_login.qq_robot_bindings DROP CONSTRAINT fail_transfer');
  assert.deepEqual(await service.bind('111', code.code), { qq: '111', userId });
});

async function fixture(t: TestContext, overrides: Partial<typeof config> = {}) {
  const serviceConfig = { ...config, ...overrides };
  const db = new PGlite(); let clock = start; let tail = Promise.resolve(); let ended = false;
  const pool = { async connect() {
    const previous = tail; let unlock!: () => void;
    tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    return { query: (sql: string, values?: unknown[]) => values ? db.query<Record<string, unknown>>(sql, values)
      : db.exec(sql).then(results => results.at(-1) ?? { rows: [] }), release: () => unlock() };
  }, async end() { if (!ended) { ended = true; await db.close(); } } };
  const store = new PgMcpQqBindingStore(serviceConfig, { pool, beforeInitialize: async () => {} });
  const robotStore = new PgQqRobotBindingStore(serviceConfig, { pool, beforeInitialize: async () => {} });
  const service = new McpQqBindingService(serviceConfig, { store, robotStore, now: () => clock, beforeInitialize: async () => {
    await db.exec(`CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users(
        id uuid PRIMARY KEY, username text NOT NULL, username_key text NOT NULL UNIQUE, password text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), is_invalid boolean NOT NULL DEFAULT true,
        is_admin boolean NOT NULL DEFAULT false, admin_note text NOT NULL DEFAULT '');
      INSERT INTO naruto_login.users(id, username, username_key, password, is_invalid) VALUES
        ('${userId}', 'existing', 'existing', 'existing-password', false),
        ('${otherId}', '123456789', '123456789', 'other-password', false),
        ('${disabledId}', 'disabled', 'disabled', 'disabled-password', true);
      CREATE TABLE naruto_login.qq_bindings(user_id uuid PRIMARY KEY, member_openid text NOT NULL);
      CREATE TABLE naruto_login.qq_binding_challenges(code_hash text PRIMARY KEY);
      INSERT INTO naruto_login.qq_bindings VALUES ('${userId}', '  arbitrary OpenID / 原样  ');
      INSERT INTO naruto_login.qq_binding_challenges VALUES ('old-openid-challenge');`);
  } });
  t.after(() => service.close());
  return { service, store: robotStore, db, advance: (ms: number) => { clock += ms; } };
}

test('直接绑定无需网站地址、登录或注册审批，创建可用普通账号且只返回 QQ 和 UUID', async t => {
  const { service, db } = await fixture(t, { hyrzPublicUrl: undefined });
  const binding = await service.bind('123456789');
  assert.deepEqual(Object.keys(binding).sort(), ['qq', 'userId']);
  assert.equal(binding.qq, '123456789');
  assert.match(binding.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const account = (await db.query<Record<string, unknown>>('SELECT * FROM naruto_login.users WHERE id = $1', [binding.userId])).rows[0];
  assert.equal(account.is_invalid, false); assert.equal(account.is_admin, false);
  assert.match(account.username as string, /^[\p{Script=Han}A-Za-z0-9_-]{3,24}$/u);
  assert.equal(account.username_key, (account.username as string).toLowerCase());
  assert.notEqual(account.username, binding.qq);
  assert.notEqual(account.username, binding.userId.replaceAll('-', '').slice(0, 24));
  assert.ok(typeof account.password === 'string' && account.password.length >= 32 && account.password.length <= 128);
  assert.equal(new Date(account.created_at as string).toISOString(), '2026-11-06T00:00:00.000Z');
  assert.deepEqual(await service.resolveRobot(binding.qq), binding);
  assert.deepEqual((await db.query('SELECT bound_at FROM naruto_login.qq_robot_bindings WHERE user_id = $1', [binding.userId])).rows,
    [{ bound_at: new Date(start) }]);
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows,
    [{ user_id: userId, member_openid: '  arbitrary OpenID / 原样  ' }]);
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_binding_challenges')).rows, [{ code_hash: 'old-openid-challenge' }]);
});

test('同一 QQ 重试及并发直接绑定只创建一个账号，不同 QQ 各自创建账号和随机凭据', async t => {
  const { service, db, advance } = await fixture(t);
  const bindings = await Promise.all(Array.from({ length: 8 }, () => service.bind('111')));
  for (const binding of bindings) assert.deepEqual(binding, bindings[0]);
  advance(1000);
  assert.deepEqual(await service.bind('111'), bindings[0]);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 4);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_robot_bindings')).rows.length, 1);
  assert.deepEqual((await db.query('SELECT bound_at FROM naruto_login.qq_robot_bindings')).rows, [{ bound_at: new Date(start) }]);
  const other = await service.bind('222');
  assert.notEqual(other.userId, bindings[0].userId);
  const created = (await db.query<{ username: string; password: string }>('SELECT username, password FROM naruto_login.users WHERE id = ANY($1::uuid[])',
    [[bindings[0].userId, other.userId]])).rows;
  assert.equal(created.length, 2);
  assert.notEqual(created[0].username, created[1].username);
  assert.notEqual(created[0].password, created[1].password);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 5);
});

test('新机器人直接绑定不复用旧确认映射，也不撤销旧待确认链接', async t => {
  const { service, db } = await fixture(t);
  await service.confirm(userId, tokenOf(await service.create('111')));
  const pending = tokenOf(await service.create('111'));
  const robot = await service.bind('111');
  assert.notEqual(robot.userId, userId);
  assert.equal((await service.preview(pending)).qq, '111');
  assert.deepEqual(await service.resolve('111'), { qq: '111', userId });
  assert.deepEqual(await service.resolveRobot('111'), robot);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 4);
});

test('旧链接确认不会读写新机器人绑定或消耗新码', async t => {
  const { service } = await fixture(t);
  const pending = tokenOf(await service.create('111'));
  const robot = await service.bind('111');
  const code = await service.createChallenge(otherId);
  await service.confirm(userId, pending);
  assert.deepEqual(await service.resolveRobot('111'), robot);
  assert.equal((await service.getStatus(otherId)).challenge?.id, code.id);
  assert.deepEqual(await service.resolve('111'), { qq: '111', userId });
  await service.unbind(userId);
  assert.deepEqual(await service.resolveRobot('111'), robot);
  assert.equal((await service.getStatus(otherId)).challenge?.id, code.id);
});

test('已绑定账号停用后直接绑定返回 MCP_USER_INACTIVE，不创建替代账号或复活原账号', async t => {
  const { service, db } = await fixture(t);
  await service.bind('111', (await service.createChallenge(userId)).code);
  await db.query('UPDATE naruto_login.users SET is_invalid = true WHERE id = $1', [userId]);
  await assert.rejects(service.bind('111'), error => error instanceof ApiError && error.code === 'MCP_USER_INACTIVE');
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
  assert.deepEqual((await db.query('SELECT user_id FROM naruto_login.qq_robot_bindings')).rows, [{ user_id: userId }]);
  assert.equal((await db.query<{ is_invalid: boolean }>('SELECT is_invalid FROM naruto_login.users WHERE id = $1', [userId])).rows[0].is_invalid, true);
});

test('关联写入失败时回滚新用户、绑定及旧链接撤销', async t => {
  const { service, db } = await fixture(t);
  const pending = tokenOf(await service.create('111'));
  await service.getStatus(userId);
  await db.exec("ALTER TABLE naruto_login.qq_robot_bindings ADD CHECK (qq_number <> '111')");
  await assert.rejects(service.bind('111'), status(503));
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_robot_bindings')).rows.length, 0);
  assert.equal((await service.preview(pending)).qq, '111');
});

test('直接绑定不会根据同名网站用户名接管账号', async t => {
  const { service, db } = await fixture(t);
  const binding = await service.bind('123456789');
  assert.notEqual(binding.userId, otherId);
  assert.deepEqual((await db.query('SELECT username, username_key, password, is_invalid, is_admin FROM naruto_login.users WHERE id = $1', [otherId])).rows,
    [{ username: '123456789', username_key: '123456789', password: 'other-password', is_invalid: false, is_admin: false }]);
});

test('直接绑定严格拒绝非法 QQ，校验先于初始化且不增加 QQ 长度限制', async t => {
  let initialized = false;
  const lazy = new McpQqBindingService(config, { beforeInitialize: async () => { initialized = true; } });
  t.after(() => lazy.close());
  for (const qq of ['', '0', '0123', ' 123', '123 ', '1e3', '1.2', '+123', '１２３', '123\n', 123, null]) {
    await assert.rejects(lazy.bind(qq as string), status(400));
  }
  assert.equal(initialized, false);
  const { service, store } = await fixture(t);
  await assert.rejects(store.bind('0123', new Date(start)), status(400));
  assert.equal((await service.bind('1'.repeat(300))).qq, '1'.repeat(300));
});

