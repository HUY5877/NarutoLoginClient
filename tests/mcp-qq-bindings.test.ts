import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { McpQqBindingService, PgMcpQqBindingStore } from '../src/server/mcp-qq-bindings.js';
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

async function fixture(t: TestContext, overrides: Partial<typeof config> = {}) {
  const serviceConfig = { ...config, ...overrides };
  const db = new PGlite(); let clock = start; let tail = Promise.resolve();
  const pool = { async connect() {
    const previous = tail; let unlock!: () => void;
    tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    return { query: (sql: string, values?: unknown[]) => values ? db.query<Record<string, unknown>>(sql, values)
      : db.exec(sql).then(results => results.at(-1) ?? { rows: [] }), release: () => unlock() };
  }, async end() { await db.close(); } };
  const store = new PgMcpQqBindingStore(serviceConfig, { pool, beforeInitialize: async () => {} });
  const service = new McpQqBindingService(serviceConfig, { store, now: () => clock, beforeInitialize: async () => {
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
  return { service, store, db, advance: (ms: number) => { clock += ms; } };
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
  assert.deepEqual(await service.resolve(binding.qq), binding);
  assert.deepEqual((await db.query('SELECT bound_at FROM naruto_login.qq_number_bindings WHERE user_id = $1', [binding.userId])).rows,
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
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_number_bindings')).rows.length, 1);
  assert.deepEqual((await db.query('SELECT bound_at FROM naruto_login.qq_number_bindings')).rows, [{ bound_at: new Date(start) }]);
  const other = await service.bind('222');
  assert.notEqual(other.userId, bindings[0].userId);
  const created = (await db.query<{ username: string; password: string }>('SELECT username, password FROM naruto_login.users WHERE id = ANY($1::uuid[])',
    [[bindings[0].userId, other.userId]])).rows;
  assert.equal(created.length, 2);
  assert.notEqual(created[0].username, created[1].username);
  assert.notEqual(created[0].password, created[1].password);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 5);
});

test('直接绑定复用旧确认流程的有效绑定并撤销相同 QQ 的待确认链接', async t => {
  const { service, db } = await fixture(t);
  await service.confirm(userId, tokenOf(await service.create('111')));
  const pending = tokenOf(await service.create('111'));
  assert.deepEqual(await service.bind('111'), { qq: '111', userId });
  await assert.rejects(service.preview(pending), status(409));
  await assert.rejects(service.confirm(otherId, pending), status(409));
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
});

test('直接创建绑定撤销相同 QQ 的旧链接，不能被旧链接抢绑', async t => {
  const { service } = await fixture(t);
  const pending = tokenOf(await service.create('111'));
  const binding = await service.bind('111');
  await assert.rejects(service.confirm(userId, pending), status(409));
  assert.deepEqual(await service.resolve('111'), binding);
});

test('已绑定账号停用后直接绑定返回 MCP_USER_INACTIVE，不创建替代账号或复活原账号', async t => {
  const { service, db } = await fixture(t);
  await service.confirm(userId, tokenOf(await service.create('111')));
  await db.query('UPDATE naruto_login.users SET is_invalid = true WHERE id = $1', [userId]);
  await assert.rejects(service.bind('111'), error => error instanceof ApiError && error.code === 'MCP_USER_INACTIVE');
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
  assert.deepEqual((await db.query('SELECT user_id FROM naruto_login.qq_number_bindings')).rows, [{ user_id: userId }]);
  assert.equal((await db.query<{ is_invalid: boolean }>('SELECT is_invalid FROM naruto_login.users WHERE id = $1', [userId])).rows[0].is_invalid, true);
});

test('关联写入失败时回滚新用户、绑定及旧链接撤销', async t => {
  const { service, db } = await fixture(t);
  const pending = tokenOf(await service.create('111'));
  await db.exec("ALTER TABLE naruto_login.qq_number_bindings ADD CHECK (qq_number <> '111')");
  await assert.rejects(service.bind('111'), status(503));
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_number_bindings')).rows.length, 0);
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

test('未配置网站地址时从本次请求生成链接，不同请求不会串地址', async t => {
  const { service } = await fixture(t, { hyrzPublicUrl: undefined });
  for (const origin of ['https://test.example', 'https://second.example/', 'http://localhost:4300', 'http://127.0.0.1:4300', 'http://[::1]:4300']) {
    const created = await service.create('123456789', origin);
    assert.equal(new URL(created.bindingUrl).origin, new URL(origin).origin);
    assert.equal((await service.preview(tokenOf(created))).qq, '123456789');
  }
  await assert.rejects(service.create('123456789'), status(503));
});

test('配置的网站地址优先于当前请求地址', async t => {
  const { service } = await fixture(t);
  const created = await service.create('123456789', 'https://preview.example');
  assert.equal(new URL(created.bindingUrl).origin, 'https://hyrz.example');
});

test('非法网站根地址在建表和写入前被拒绝', async () => {
  for (const origin of [undefined, '', 'https://', 'http://site.example', 'http://localhost.evil', 'ftp://site.example',
    'https://user:pass@site.example', 'https://@site.example', 'https://site.example/path', 'https://site.example//',
    'https://site.example?x=1', 'https://site.example?', 'https://site.example#part', 'https://site.example#',
    ' https://site.example', 'https://site.example ', 'https://site.example\\path', 'https://site.example\n']) {
    let initialized = false;
    const service = new McpQqBindingService({ databaseUrl: config.databaseUrl, timeoutMs: config.timeoutMs }, {
      beforeInitialize: async () => { initialized = true; throw new Error('unexpected initialization'); },
    });
    await assert.rejects(service.create('123456789', origin), status(503), String(origin));
    assert.equal(initialized, false, String(origin));
    await service.close();
  }
});

test('非法配置地址也不能绕过根地址限制或降级到请求地址', async () => {
  for (const origin of ['http://site.example', 'https://@site.example', 'https://site.example?', 'https://site.example#']) {
    let initialized = false;
    const service = new McpQqBindingService({ ...config, hyrzPublicUrl: origin }, {
      beforeInitialize: async () => { initialized = true; throw new Error('unexpected initialization'); },
    });
    await assert.rejects(service.create('123456789', 'https://valid.example'), status(503), origin);
    assert.equal(initialized, false, origin);
    await service.close();
  }
});

test('未确认的数字 QQ 只能预览，数据库仅保存令牌摘要', async t => {
  const { service, db } = await fixture(t);
  const created = await service.create('123456789'); const token = tokenOf(created);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.bindingUrl, `https://hyrz.example/#mcp-bind=${token}`);
  assert.equal(created.expiresAt, '2026-11-06T00:05:00.000Z');
  assert.deepEqual(await service.preview(token), { qq: '123456789', expiresAt: created.expiresAt });
  await assert.rejects(service.resolve('123456789'), status(404));
  const rows = (await db.query<{ token_hash: string }>('SELECT * FROM naruto_login.qq_number_binding_requests')).rows;
  assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  assert(!JSON.stringify(rows).includes(token));
});

test('确认和重复确认返回同一关联，其他账号不能消费已确认令牌', async t => {
  const { service, advance } = await fixture(t); const token = tokenOf(await service.create('123456789'));
  const expected = { qq: '123456789', userId, boundAt: '2026-11-06T00:00:00.000Z' };
  assert.deepEqual(await service.confirm(userId, token), expected);
  advance(1000);
  assert.deepEqual(await service.confirm(userId, token), expected);
  assert.deepEqual(await service.resolve('123456789'), { qq: '123456789', userId });
  await assert.rejects(service.confirm(otherId, token), status(409));
});

test('QQ 唯一冲突保留双方原有绑定，新的挑战不能抢绑', async t => {
  const { service } = await fixture(t);
  await service.confirm(userId, tokenOf(await service.create('111')));
  await service.confirm(otherId, tokenOf(await service.create('222')));
  const token = tokenOf(await service.create('111'));
  await assert.rejects(service.confirm(otherId, token), status(409));
  assert.deepEqual(await service.resolve('111'), { qq: '111', userId });
  assert.deepEqual(await service.resolve('222'), { qq: '222', userId: otherId });
});

test('新挑战撤销旧挑战，到期边界拒绝确认且不产生绑定', async t => {
  const { service, advance } = await fixture(t);
  const old = tokenOf(await service.create('111')); const current = tokenOf(await service.create('111'));
  await assert.rejects(service.preview(old), status(409));
  await assert.rejects(service.confirm(userId, old), status(409));
  advance(300000);
  await assert.rejects(service.preview(current), status(409));
  await assert.rejects(service.confirm(userId, current), status(409));
  await assert.rejects(service.resolve('111'), status(404));
});

test('解绑撤销该 QQ 所有旧请求，重复解绑和其他账号重放都不会复活', async t => {
  const { service } = await fixture(t);
  const consumed = tokenOf(await service.create('111')); await service.confirm(userId, consumed);
  const pending = tokenOf(await service.create('111'));
  assert.deepEqual(await service.unbind(userId), { userId, status: 'unbound' });
  assert.deepEqual(await service.unbind(userId), { userId, status: 'unbound' });
  for (const token of [consumed, pending]) for (const owner of [userId, otherId]) {
    await assert.rejects(service.confirm(owner, token), status(409));
  }
  await assert.rejects(service.resolve('111'), status(404));
});

test('同一账号切换 QQ 后旧号码请求失效，openid 表和旧挑战逐字保留', async t => {
  const { service, db } = await fixture(t);
  const first = tokenOf(await service.create('111')); await service.confirm(userId, first);
  const oldPending = tokenOf(await service.create('111'));
  await service.confirm(userId, tokenOf(await service.create('222')));
  for (const token of [first, oldPending]) await assert.rejects(service.confirm(userId, token), status(409));
  await assert.rejects(service.resolve('111'), status(404));
  assert.deepEqual(await service.resolve('222'), { qq: '222', userId });
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows,
    [{ user_id: userId, member_openid: '  arbitrary OpenID / 原样  ' }]);
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_binding_challenges')).rows, [{ code_hash: 'old-openid-challenge' }]);
});

test('每次读取有效账号，停用或删除后拒绝查询和确认', async t => {
  const { service, db } = await fixture(t); const token = tokenOf(await service.create('111'));
  for (const id of [disabledId, missingId]) {
    await assert.rejects(service.assertActiveUser(id), status(403));
    await assert.rejects(service.confirm(id, token), status(403));
    await assert.rejects(service.unbind(id), status(403));
  }
  await service.assertActiveUser(userId); await service.confirm(userId, token);
  await db.query('UPDATE naruto_login.users SET is_invalid = true WHERE id = $1', [userId]);
  await assert.rejects(service.assertActiveUser(userId), status(403));
  await assert.rejects(service.resolve('111'), status(404));
  await assert.rejects(service.confirm(userId, token), status(403));
  await db.query('DELETE FROM naruto_login.users WHERE id = $1', [userId]);
  await assert.rejects(service.resolve('111'), status(404));
});

test('严格校验 QQ 和 UUID，不纠正空格、前导零或数字输入，也不增加 QQ 长度限制', async t => {
  const { service } = await fixture(t);
  for (const qq of ['', '0', '0123', ' 123', '123 ', '1e3', '1.2', '+123', '１２３', '123\n', 123, null]) {
    await assert.rejects(service.create(qq as string), status(400));
    await assert.rejects(service.resolve(qq as string), status(400));
  }
  for (const id of ['', ' 10000000-0000-4000-8000-000000000001', '10000000-0000-1000-8000-000000000001', 123]) {
    await assert.rejects(service.assertActiveUser(id as string), status(400));
  }
  const long = '1'.repeat(300); const created = await service.create(long);
  assert.equal((await service.preview(tokenOf(created))).qq, long);
  for (const token of ['', 'x', 'x'.repeat(43) + '\n', null]) await assert.rejects(service.preview(token as string), status(400));
});

test('并发确认不会让同一 QQ 归属两个账号', async t => {
  const { service, db } = await fixture(t); const token = tokenOf(await service.create('111'));
  const results = await Promise.allSettled([service.confirm(userId, token), service.confirm(otherId, token)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && status(409)(r.reason)).length, 1);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_number_bindings')).rows.length, 1);
});

test('大小写 UUID 指向同一账号，重复确认保持幂等', async t => {
  const { service } = await fixture(t); const token = tokenOf(await service.create('111'));
  const first = await service.confirm(userId.toUpperCase(), token);
  assert.deepEqual(await service.confirm(userId.toUpperCase(), token), first);
  assert.deepEqual(await service.confirm(userId, token), first);
});

test('同一账号再次确认相同 QQ 不改变绑定时间，两个令牌重试均保持幂等', async t => {
  const { service, advance } = await fixture(t); const first = tokenOf(await service.create('111'));
  const original = await service.confirm(userId, first); advance(1000);
  const second = tokenOf(await service.create('111'));
  assert.deepEqual(await service.confirm(userId, second), original);
  assert.deepEqual(await service.confirm(userId, first), original);
  assert.deepEqual(await service.confirm(userId, second), original);
});

test('未配置时延迟拒绝，关闭可重复且不会连接数据库', async () => {
  const service = new McpQqBindingService({ timeoutMs: 100 }, { beforeInitialize: async () => assert.fail('must stay lazy') });
  await assert.rejects(service.create('111'), status(503));
  await service.close(); await service.close();
});

test('数据库异常只返回安全 ApiError，不暴露原始驱动信息', async () => {
  const store = new PgMcpQqBindingStore(config, { beforeInitialize: async () => {}, pool: {
    connect: async () => { throw new Error('postgres://secret:password@private-db/fixture token=private'); }, end: async () => {},
  } });
  const service = new McpQqBindingService(config, { beforeInitialize: async () => {}, store });
  await assert.rejects(service.create('111'), error => status(503)(error) && !String(error).includes('private'));
  await service.close(); await service.close();
});

test('创建链接会回收所有过期状态，保留有效重试记录、数字绑定和旧 openid 数据', async t => {
  const { service, db, advance } = await fixture(t);
  const expiredConfirmed = tokenOf(await service.create('111'));
  const original = await service.confirm(userId, expiredConfirmed);
  await service.create('222'); await service.create('222'); // revoked and pending
  await service.create('333');
  advance(240000);
  const confirmed = tokenOf(await service.create('444'));
  const active = await service.confirm(otherId, confirmed);
  const pending = tokenOf(await service.create('555'));
  advance(60000); // expires_at = now is expired too
  await service.create('666');
  assert.deepEqual((await db.query('SELECT qq_number, status FROM naruto_login.qq_number_binding_requests ORDER BY qq_number')).rows,
    [{ qq_number: '444', status: 'confirmed' }, { qq_number: '555', status: 'pending' }, { qq_number: '666', status: 'pending' }]);
  assert.deepEqual(await service.confirm(otherId, confirmed), active);
  assert.equal((await service.preview(pending)).qq, '555');
  assert.deepEqual(await service.resolve('111'), { qq: '111', userId });
  assert.deepEqual((await db.query('SELECT bound_at FROM naruto_login.qq_number_bindings WHERE user_id=$1', [userId])).rows,
    [{ bound_at: new Date(original.boundAt) }]);
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows,
    [{ user_id: userId, member_openid: '  arbitrary OpenID / 原样  ' }]);
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_binding_challenges')).rows, [{ code_hash: 'old-openid-challenge' }]);
  assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE schemaname='naruto_login' AND tablename='qq_number_binding_requests' AND indexdef LIKE '%(expires_at)%'")).rows.length, 1);
});
