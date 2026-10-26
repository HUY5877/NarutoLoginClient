import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createPrivateKey, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { QqBindingService, verifyQqWebhook } from '../src/server/qq-binding.js';
import { PgQqBindingStore } from '../src/server/qq-binding-store.js';

const { PGlite } = createRequire(new URL('../src/server/package.json', import.meta.url))('@electric-sql/pglite') as
  typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
const userId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const thirdId = '10000000-0000-4000-8000-000000000003';
const start = Date.parse('2026-10-26T12:00:00Z');
const bot = { appId: '11111111', appSecret: 'DG5g3B4j9X2KOErG', groupOpenid: 'group-fixture' };
const config = { ...loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/fixture' }), qqBot: bot };
const cookie = { Cookie: 'naruto_session=fixture.user.signature', 'Content-Type': 'application/json' };
const otherCookie = { ...cookie, Cookie: 'naruto_session=fixture.other.signature' };
const post = { method: 'POST', headers: cookie, body: '{}' };
const unavailable = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 503;

// Test-only pool serializes PGlite's single connection; every statement and rollback uses real PostgreSQL semantics.
async function fixture(t: TestContext) {
  const db = new PGlite();
  let tail = Promise.resolve();
  let clock = start;
  const pool = { async connect() {
    const previous = tail; let unlock!: () => void;
    tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    return { query: (sql: string, values?: unknown[]) => values ? db.query<Record<string, unknown>>(sql, values)
      : db.exec(sql).then(results => results[results.length - 1] ?? { rows: [] }), release: () => unlock() };
  }, async end() { await db.close(); } };
  const store = new PgQqBindingStore(config, { pool, beforeInitialize: async () => {
    await db.exec(`CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users(id uuid PRIMARY KEY);
      INSERT INTO naruto_login.users VALUES ('${userId}'), ('${otherId}'), ('${thirdId}');`);
  } });
  const service = new QqBindingService(config, { store, now: () => clock });
  t.after(() => store.close());
  return { db, store, service, now: () => clock, advance: (ms: number) => { clock += ms; } };
}

function signed(raw: string, time = start, appId = bot.appId) {
  const timestamp = String(Math.floor(time / 1000));
  const seed = Buffer.from(bot.appSecret.repeat(32)).subarray(0, 32);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return { 'Content-Type': 'application/json', 'X-Bot-Appid': appId, 'X-Signature-Timestamp': timestamp,
    'X-Signature-Ed25519': sign(null, Buffer.from(timestamp + raw), key).toString('hex') };
}
const event = (code: string, member = 'member-fixture', extra: Record<string, unknown> = {}) => JSON.stringify({ op: 0, id: 'event-fixture', t: 'GROUP_AT_MESSAGE_CREATE',
  d: { id: 'message-fixture', group_openid: bot.groupOpenid, author: { member_openid: member }, content: ` 绑定 ${code}`, ...extra } });
async function receive(service: QqBindingService, raw: string, time = start) {
  const headers = signed(raw, time);
  return service.handleWebhook(Buffer.from(raw), { appId: headers['X-Bot-Appid'], timestamp: headers['X-Signature-Timestamp'], signature: headers['X-Signature-Ed25519'] });
}
async function withApi(service: QqBindingService | undefined, run: (base: string) => Promise<void>) {
  const deps: Dependencies = { qqBindings: service,
    auth: { getUser: async token => token === 'fixture.user.signature' ? { id: userId, username: '鸣人', isAdmin: false }
      : token === 'fixture.other.signature' ? { id: otherId, username: '佐助', isAdmin: false } : null,
    register: async () => assert.fail(), login: async () => assert.fail(), listApplications: async () => assert.fail(), reviewApplication: async () => assert.fail() },
    events: { create: async () => assert.fail(), getForUser: async () => assert.fail(), getActive: async () => null, recordStatus: async () => {} },
    storage: { exists: async () => false, read: async () => null } };
  const app = createApp(config, deps); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('官方固定 Ed25519 请求向量独立验证原始请求体，修改空格或时间即失败', () => {
  // The official signature corresponds to this two-space-indented body, including its newlines.
  const raw = Buffer.from('{\n  "op": 0,\n  "d": {},\n  "t": "GATEWAY_EVENT_NAME"\n}');
  const signature = '865ad13a61752ca65e26bde6676459cd36cf1be609375b37bd62af366e1dc25a8dc789ba7f14e017ada3d554c671a911bfdf075ba54835b23391d509579ed002';
  assert.equal(verifyQqWebhook('naOC0ocQE3shWLAfffVLB1rhYPG7', '1725442341', raw, signature), true);
  assert.equal(verifyQqWebhook('naOC0ocQE3shWLAfffVLB1rhYPG7', '1725442342', raw, signature), false);
  assert.equal(verifyQqWebhook('naOC0ocQE3shWLAfffVLB1rhYPG7', '1725442341', Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), signature), false);
});

test('公开挑战使用官方固定签名向量，回调绕过会话和普通 JSON/CSRF 中间件', async t => {
  // Validation must work before users, the binding schema, or a database connection are available.
  const service = new QqBindingService({ ...config, databaseUrl: undefined }, { initializeUsers: async () => assert.fail('validation must not initialize users') });
  await withApi(service, async base => {
    const response = await fetch(`${base}/api/qq/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Appid': bot.appId, Origin: 'https://qq.example' },
      body: JSON.stringify({ op: 13, d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { plain_token: 'Arq0D5A61EgUu4OxUvOp', signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706' });
  });
});

test('公开挑战不充当事件签名接口，拒绝可伪装为群事件的 plain_token', async t => {
  const { service } = await fixture(t);
  const { code } = await service.createChallenge(userId);
  const forgedEvent = event(code, 'attacker-member');
  await withApi(service, async base => {
    const response = await fetch(`${base}/api/qq/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Appid': bot.appId },
      body: JSON.stringify({ op: 13, d: { plain_token: forgedEvent, event_ts: String(Math.floor(start / 1000)) } }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).signature, undefined);
    assert.equal((await service.getStatus(userId)).challenge?.received, false);
  });
});

test('完成生成码、群消息、网页确认和解绑，浏览器不接收成员标识与哈希', async t => {
  const { service, db } = await fixture(t);
  await withApi(service, async base => {
    assert.equal((await fetch(`${base}/api/qq-binding`)).status, 401);
    const challengeResponse = await fetch(`${base}/api/qq-binding/challenge`, post); assert.equal(challengeResponse.status, 201);
    const challenge = await challengeResponse.json(); assert.match(challenge.code, /^[A-Z0-9]{8}$/);
    assert.match(challenge.id, /^[0-9a-f-]{36}$/);
    assert.equal(challenge.expiresAt, '2026-10-26T12:05:00.000Z');
    const rows = await db.query<{ code_hash: string }>('SELECT code_hash FROM naruto_login.qq_binding_challenges');
    assert.match(rows.rows[0].code_hash, /^[a-f0-9]{64}$/); assert(!JSON.stringify(rows.rows).includes(challenge.code));
    const raw = event(challenge.code);
    const webhook = await fetch(`${base}/api/qq/events`, { method: 'POST', headers: signed(raw), body: raw });
    assert.deepEqual(await webhook.json(), { op: 12 });
    const status = await (await fetch(`${base}/api/qq-binding`, { headers: cookie })).json();
    assert.deepEqual(status, { enabled: true, binding: null, challenge: { id: challenge.id, expiresAt: challenge.expiresAt, received: true, senderName: null } });
    assert(!JSON.stringify(status).includes('member-fixture')); assert(!JSON.stringify(status).includes('codeHash'));
    const confirmBody = JSON.stringify({ challengeId: challenge.id });
    assert.equal((await fetch(`${base}/api/qq-binding/confirm`, { ...post, body: confirmBody, headers: otherCookie })).status, 409);
    const confirmed = await fetch(`${base}/api/qq-binding/confirm`, { ...post, body: confirmBody }); assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { binding: { boundAt: '2026-10-26T12:00:00.000Z' } });
    assert.equal((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows.length, 1);
    const removed = await fetch(`${base}/api/qq-binding`, { method: 'DELETE', headers: cookie, body: '{}' }); assert.equal(removed.status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/qq-binding`, { headers: cookie })).json(), { enabled: true, binding: null, challenge: null });
    await receive(service, raw);
    assert.equal((await db.query('SELECT * FROM naruto_login.qq_binding_challenges')).rows.length, 0);
  });
});

test('匿名与跨站不能修改绑定，未配置状态可读且无法生成码', async t => {
  const { service } = await fixture(t);
  await withApi(service, async base => {
    for (const path of ['/api/qq-binding/challenge', '/api/qq-binding/confirm', '/api/qq-binding']) {
      const method = path === '/api/qq-binding' ? 'DELETE' : 'POST';
      assert.equal((await fetch(`${base}${path}`, { ...post, method, headers: { 'Content-Type': 'application/json' } })).status, 401);
      assert.equal((await fetch(`${base}${path}`, { ...post, method, headers: { ...cookie, Origin: 'https://hostile.example' } })).status, 403);
    }
  });
  await withApi(undefined, async base => {
    assert.deepEqual(await (await fetch(`${base}/api/qq-binding`, { headers: cookie })).json(), { enabled: false, binding: null, challenge: null });
    assert.equal((await fetch(`${base}/api/qq-binding/challenge`, post)).status, 503);
  });
});

test('回调拒绝无效签名、原文变化、过期/未来时间和其他 AppID，错误群与无效成员不写候选', async t => {
  const { service, db } = await fixture(t); const { code } = await service.createChallenge(userId); const raw = event(code);
  await withApi(service, async base => {
    for (const headers of [ { ...signed(raw), 'X-Signature-Ed25519': '00'.repeat(64) }, signed(raw, start - 301000), signed(raw, start + 301000), signed(raw, start, '22222222'),
      { ...signed(raw), 'X-Signature-Timestamp': 'bad' }, { ...signed(raw), 'X-Signature-Ed25519': 'bad' } ]) {
      const response = await fetch(`${base}/api/qq/events`, { method: 'POST', headers, body: raw }); assert.equal(response.status, 401);
    }
    assert.equal((await fetch(`${base}/api/qq/events`, { method: 'POST', headers: signed(raw), body: raw + ' ' })).status, 401);
    const large = JSON.stringify({ op: 0, d: 'x'.repeat(70 * 1024) });
    assert.equal((await fetch(`${base}/api/qq/events`, { method: 'POST', headers: signed(large), body: large })).status, 400);
  });
  await receive(service, event(code, 'member-fixture', { group_openid: 'other-group' }));
  await receive(service, event(code, '', {}));
  await receive(service, event(code, 'member-fixture', { author: { id: 'legacy-id' } }));
  assert.equal((await db.query<{ member_openid: string | null }>('SELECT member_openid FROM naruto_login.qq_binding_challenges')).rows[0].member_openid, null);
});

test('首个候选保持不变，重新生成与到期令旧码失效，旧绑定保留到再次确认', async t => {
  const { service, db, advance, now } = await fixture(t); const first = await service.createChallenge(userId);
  await Promise.all([receive(service, event(first.code, 'first-member')), receive(service, event(first.code, 'second-member'))]);
  await service.confirm(userId, { challengeId: first.id });
  assert.equal((await db.query<{ member_openid: string }>('SELECT member_openid FROM naruto_login.qq_bindings')).rows[0].member_openid, 'first-member');
  const oldBinding = (await service.getStatus(userId)).binding; assert(oldBinding);
  const replaced = await service.createChallenge(userId); const current = await service.createChallenge(userId);
  await receive(service, event(replaced.code, 'wrong-member'));
  assert.equal((await service.getStatus(userId)).challenge?.received, false);
  assert.deepEqual((await service.getStatus(userId)).binding, oldBinding);
  await receive(service, event(current.code, 'new-member'));
  advance(300000);
  assert.equal((await service.getStatus(userId)).challenge, null);
  await assert.rejects(service.confirm(userId, { challengeId: current.id }), error => !!error && typeof error === 'object' && 'status' in error && error.status === 409);
  await receive(service, event(current.code), now());
  assert.equal((await service.getStatus(userId)).challenge, null);
});

test('成员唯一约束拒绝其他网站账号，事务回滚保留已有绑定与挑战', async t => {
  const { service, db } = await fixture(t);
  for (const [owner, member] of [[userId, 'same-member'], [otherId, 'other-member']]) {
    const { id, code } = await service.createChallenge(owner); await receive(service, event(code, member)); await service.confirm(owner, { challengeId: id });
  }
  const { id, code } = await service.createChallenge(otherId); await receive(service, event(code, 'same-member'));
  await assert.rejects(service.confirm(otherId, { challengeId: id }), error => !!error && typeof error === 'object' && 'status' in error && error.status === 409);
  assert.equal((await db.query<{ member_openid: string }>('SELECT member_openid FROM naruto_login.qq_bindings WHERE user_id = $1', [otherId])).rows[0].member_openid, 'other-member');
  assert.equal((await service.getStatus(otherId)).challenge?.received, true);
  await assert.rejects(db.query(`INSERT INTO naruto_login.qq_bindings(user_id, bot_app_id, group_openid, member_openid, bound_at)
    VALUES ($1, $2, $3, $4, $5)`, [thirdId, bot.appId, bot.groupOpenid, 'same-member', new Date(start)]), error => !!error && typeof error === 'object' && 'code' in error && error.code === '23505');
});

test('scope 隔离并且删除用户级联清除绑定与挑战', async t => {
  const { service, store, db } = await fixture(t); const a = await service.createChallenge(userId); await receive(service, event(a.code)); await service.confirm(userId, { challengeId: a.id });
  const another = new QqBindingService({ ...config, qqBot: { ...bot, appId: '22222222', groupOpenid: 'other-group' } }, { store, now: () => start });
  assert.deepEqual(await another.getStatus(userId), { enabled: true, binding: null, challenge: null });
  await another.createChallenge(userId); await service.unbind(userId);
  assert.equal((await another.getStatus(userId)).challenge?.received, false);
  await db.query('DELETE FROM naruto_login.users WHERE id = $1', [userId]);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_binding_challenges')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows.length, 0);
});

test('并发重新生成、确认、解绑串行化，确认过的旧码不复活', async t => {
  const { service, db } = await fixture(t); const first = await service.createChallenge(userId); await receive(service, event(first.code));
  // Regeneration takes the user's lock first. Confirmation must see the new empty challenge, then unbind clears it.
  const results = await Promise.allSettled([service.createChallenge(userId), service.confirm(userId, { challengeId: first.id }), service.unbind(userId)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[2].status, 'fulfilled');
  await receive(service, event(first.code));
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_bindings')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_binding_challenges')).rows.length, 0);
});

test('数据库持久化失败回调不确认成功且隐藏内部错误', async t => {
  const { service, db } = await fixture(t); const { code } = await service.createChallenge(userId);
  await db.exec(`CREATE FUNCTION fail_candidate() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'secret driver connection detail'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER failure BEFORE UPDATE ON naruto_login.qq_binding_challenges FOR EACH ROW EXECUTE FUNCTION fail_candidate();`);
  const raw = event(code);
  await withApi(service, async base => {
    const response = await fetch(`${base}/api/qq/events`, { method: 'POST', headers: signed(raw), body: raw });
    assert.equal(response.status, 503); const body = await response.json(); assert(!JSON.stringify(body).includes('secret')); assert.equal(body.op, undefined);
  });
  await assert.rejects(receive(service, raw), unavailable);
});

test('另一页面重新生成候选后，旧页面的确认不能绑定新候选', async t => {
  const { service } = await fixture(t);
  const first = await service.createChallenge(userId);
  await receive(service, event(first.code, 'first-member'));
  const oldStatus = await service.getStatus(userId);
  const second = await service.createChallenge(userId);
  await receive(service, event(second.code, 'second-member'));
  const currentStatus = await service.getStatus(userId);
  await assert.rejects(service.confirm(userId, { challengeId: oldStatus.challenge?.id }),
    error => !!error && typeof error === 'object' && 'status' in error && error.status === 409);
  assert.equal((await service.getStatus(userId)).binding, null);
  const confirmed = await service.confirm(userId, { challengeId: currentStatus.challenge?.id });
  assert(confirmed.binding);
});
