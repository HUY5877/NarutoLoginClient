import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { parseQqAuthorization, QqAuthorizationCipher, verifyQqAuthorization, validateQqJson } from '../src/server/qq-authorization-data.js';
import { PgQqAuthorizationStore, QqAuthorizationService, type QqAuthorizationRecord, type QqAuthorizationStore } from '../src/server/qq-authorizations.js';

const start = Date.parse('2026-10-23T02:00:00Z');
const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const token = '1234567890abcdef'.repeat(2), openid = 'abcdef1234567890'.repeat(2);
const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/naruto_login_test',
  QQ_AUTHORIZATION_ENCRYPTION_KEY: '17'.repeat(32) });
function document(overrides: Record<string, unknown> = {}) {
  return { schema_version: 1, app_id: '1104307008', captured_at_epoch_ms: start,
    callback_url: `auth://tauth.qq.com/#ret=0&access_token=${token}&openid=${openid}&expires_in=3600&auth_time=${start - 10000}&pf=openmobile_android&pfkey=fixture&pay_token=retained`, ...overrides };
}
const errorIs = (status: number, code?: string) => (error: unknown) => {
  assert(error instanceof ApiError); assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert(!error.message.includes(token)); assert(!error.message.includes(openid)); return true;
};

class MemoryStore implements QqAuthorizationStore {
  records = new Map<string, QqAuthorizationRecord>(); initialized = 0;
  async initialize() { this.initialized++; }
  async close() {}
  async upsert(record: QqAuthorizationRecord) {
    const existing = [...this.records.values()].find(row => row.ownerId === record.ownerId && row.fingerprint === record.fingerprint);
    if (existing && existing.capturedAt > record.capturedAt) return existing;
    const result = { ...record, id: existing?.id ?? record.id };
    this.records.set(result.id, result); return result;
  }
  async list(user: string) { return [...this.records.values()].filter(row => row.ownerId === user); }
  async get(user: string, id: string) { const row = this.records.get(id); return row?.ownerId === user ? row : null; }
  async delete(user: string, id: string) { if ((await this.get(user, id)) === null) return false; return this.records.delete(id); }
}

test('完整回调按原始 auth_time 计算有效期，原文及非登录参数保留', () => {
  const parsed = parseQqAuthorization(document(), start + 5000);
  assert.equal(parsed.expiresAt, start - 10000 + 3600000);
  assert.deepEqual(parsed.authorization, document());
  assert.equal(parsed.fields.get('pay_token'), 'retained');
  assert.equal(parsed.fields.get('pfkey'), 'fixture');
  const seconds = document({ callback_url: document().callback_url.replace(String(start - 10000), String((start - 10000) / 1000)) });
  assert.equal(parseQqAuthorization(seconds, start).expiresAt, parsed.expiresAt);
  const noAuthTime = document({ callback_url: document().callback_url.replace(`&auth_time=${start - 10000}`, '') });
  assert.equal(parseQqAuthorization(noAuthTime, start).expiresAt, start + 3600000);
});

test('回调拒绝错误来源、重复字段、编码歧义、伪造 appid、无效时间以及过期凭证', () => {
  for (const callback_url of [
    document().callback_url.replace('auth://', 'https://'), document().callback_url.replace('tauth.qq.com/', 'tauth.qq.com.evil/'),
    document().callback_url.replace('tauth.qq.com/', 'tauth.qq.com:80/'), document().callback_url.replace('tauth.qq.com/', 'tauth.qq.com/x'),
    document().callback_url.replace('ret=0', 'ret=1'), `${document().callback_url}&ret=0`, `${document().callback_url}&%72et=0`,
    `${document().callback_url}&appid=other`, `${document().callback_url}&app_id=other`, `${document().callback_url}&extra=%C0%AF`,
    `${document().callback_url}&extra=%0A`, `${document().callback_url}&extra=%`, `${document().callback_url}&extra=你好`,
    `${document().callback_url}&extra=\\`, `${document().callback_url}&extra="`, `${document().callback_url}&extra={x}`,
    document().callback_url.replace('expires_in=3600', 'expires_in=0'), document().callback_url.replace('expires_in=3600', 'expires_in=9999999999999999999'),
    document().callback_url.replace(String(start - 10000), String(start + 1)), document().callback_url.replace('#', '?ret=0#'),
  ]) assert.throws(() => parseQqAuthorization(document({ callback_url }), start), errorIs(400));
  for (const overrides of [{ app_id: 1104307008 }, { schema_version: 2 }, { captured_at_epoch_ms: start + 1 },
    { captured_at_epoch_ms: 1.5 }, { unknown: true }]) assert.throws(() => parseQqAuthorization(document(overrides), start), errorIs(400));
  assert.throws(() => parseQqAuthorization(document(), start + 3600000), errorIs(410, 'QQ_AUTHORIZATION_EXPIRED'));
  assert.throws(() => parseQqAuthorization(document(), start - 10000 + 3600000 - 999), errorIs(410));
});

test('JSON 校验拒绝重复键和过深结构，正确处理转义键名', () => {
  for (const value of ['{"a":1,"a":2}', '{"authorization":{"a":1,"\\u0061":2}}', '{"a":[{"x":1,"x":2}]}', '{bad}',
    '{"a":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}']) assert.throws(() => validateQqJson(Buffer.from(value)), errorIs(400));
  validateQqJson(Buffer.from(JSON.stringify({ label: '中文', authorization: document(), nested: [true, null, { quoted: '\\"' }] })));
});

test('加密采用随机 nonce，绑定 owner 与账号，损坏密文和错误密钥均不能解密', () => {
  const cipher = new QqAuthorizationCipher(config.qqAuthorizationEncryptionKey!);
  const context = `${owner}:fixture`, source = parseQqAuthorization(document(), start).authorization;
  const first = cipher.encrypt(source, context), second = cipher.encrypt(source, context);
  assert.notDeepEqual(first.nonce, second.nonce); assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert(!first.ciphertext.toString('utf8').includes(token));
  assert.deepEqual(cipher.decrypt(first, context), source);
  assert.throws(() => cipher.decrypt(first, `${other}:fixture`), errorIs(503));
  assert.throws(() => new QqAuthorizationCipher('18'.repeat(32)).decrypt(first, context), errorIs(503));
  const broken = { ...first, ciphertext: Buffer.from(first.ciphertext) }; broken.ciphertext[0] ^= 1;
  assert.throws(() => cipher.decrypt(broken, context), errorIs(503));
  assert.notEqual(cipher.fingerprint(owner, openid), cipher.fingerprint(other, openid));
  assert.equal(cipher.fingerprint(owner, openid), cipher.fingerprint(owner, openid.toUpperCase()));
});

test('官方校验只请求固定 HTTPS 地址，拒绝重定向、错误应用、错误用户及异常响应', async () => {
  const parsed = parseQqAuthorization(document(), start);
  await verifyQqAuthorization(parsed, { fetch: async (url, init) => {
    assert.equal(new URL(String(url)).origin, 'https://graph.qq.com');
    assert.equal(new URL(String(url)).pathname, '/oauth2.0/me');
    assert.equal(init?.redirect, 'error'); assert(init?.signal);
    return new Response(`callback( ${JSON.stringify({ client_id: '1104307008', openid })} );`);
  } });
  for (const response of [new Response('', { status: 302 }), Response.json({ client_id: 'wrong', openid }),
    Response.json({ client_id: '1104307008', openid, error: 0 }), Response.json({ client_id: '1104307008', openid, error_code: 1 }),
    Response.json({ client_id: '1104307008', openid: 'deadbeef'.repeat(4) }), new Response('callback(bad);'),
    new Response('x'.repeat(17000)), new Response(`callback({"client_id":"1104307008","openid":"${openid}","openid":"${openid}"});`)]) {
    await assert.rejects(verifyQqAuthorization(parsed, { fetch: async () => response }), errorIs(502, 'QQ_VERIFICATION_FAILED'));
  }
  await assert.rejects(verifyQqAuthorization(parsed, { timeoutMs: 10, fetch: async () => new Promise(() => {}) }), errorIs(502));
});

test('上传先做官方校验；同用户同账号更新，列表只含元数据，下载与删除均限制本人', async () => {
  const store = new MemoryStore(); let verified = 0, now = start;
  const service = new QqAuthorizationService(config, { store, now: () => now, verify: async () => { verified++; } });
  const first = await service.upload(owner, { label: '我的一区', authorization: document() });
  assert.equal(verified, 1); assert.equal(first.item.accountHint, openid.slice(-6));
  assert.equal(Object.hasOwn(first.item, 'authorization'), false);
  now += 1000;
  const second = await service.upload(owner, { label: '重新扫码', authorization: document({ captured_at_epoch_ms: now }) });
  assert.equal(second.item.id, first.item.id); assert.equal(store.records.size, 1);
  const list = await service.list(owner); assert.equal(list.items[0].label, '重新扫码');
  const serialized = JSON.stringify(list); assert(!serialized.includes(token)); assert(!serialized.includes(openid)); assert(!serialized.includes('callback'));
  assert.deepEqual(await service.list(other), { items: [] });
  await assert.rejects(service.get(other, first.item.id), errorIs(404));
  await assert.rejects(service.delete(other, first.item.id), errorIs(404));
  const read = await service.get(owner, first.item.id); assert.equal(read.authorization.callback_url, document().callback_url);
  now = start + 3600000;
  assert.equal((await service.list(owner)).items[0].expired, true);
  await assert.rejects(service.get(owner, first.item.id), errorIs(410));
  await service.delete(owner, first.item.id); assert.equal(store.records.size, 0);
});

test('上传校验失败不写入；缺密钥及正式环境均不能调用存储', async () => {
  const store = new MemoryStore();
  const failed = new QqAuthorizationService(config, { store, now: () => start, verify: async () => { throw new Error(`secret ${token}`); } });
  await assert.rejects(failed.upload(owner, { label: '账号', authorization: document() }), errorIs(502));
  assert.equal(store.records.size, 0);
  for (const invalid of [{ ...config, qqAuthorizationEncryptionKey: undefined }, { ...config, qqAuthorizationEncryptionKey: 'bad' }, { ...config, appEnv: 'prod' as const }]) {
    const service = new QqAuthorizationService(invalid, { store });
    await assert.rejects(service.list(owner), errorIs(invalid.appEnv === 'prod' ? 404 : 503));
  }
  assert.equal(store.initialized, 0);
});

test('账号备注拒绝控制字符、超长值与损坏 Unicode；失效时间在官方校验后再次确认', async () => {
  const store = new MemoryStore(); let now = start, calls = 0;
  const service = new QqAuthorizationService(config, { store, now: () => now, verify: async () => { calls++; now += 3600000; } });
  for (const label of ['', ' ', 'a'.repeat(41), '可见\u202e反转', 'a\u2066b', 'a\u200fb', 'a\u0000b', 'a\ud800b', 'a\udfffb', 12, null]) {
    await assert.rejects(service.upload(owner, { label, authorization: document() }), errorIs(400, 'INVALID_QQ_AUTHORIZATION_LABEL'));
  }
  assert.equal(calls, 0); assert.equal(store.records.size, 0);
  await assert.rejects(service.upload(owner, { label: '校验时过期', authorization: document() }), errorIs(410));
  assert.equal(calls, 1); assert.equal(store.records.size, 0);
});

test('PostgreSQL 查询始终带 owner 条件，容量限制不截断也不写入，旧扫码不覆盖新扫码', async () => {
  const cipher = new QqAuthorizationCipher(config.qqAuthorizationEncryptionKey!);
  const row: QqAuthorizationRecord = { id: '20000000-0000-4000-8000-000000000001', ownerId: owner,
    fingerprint: cipher.fingerprint(owner, openid), label: '已有账号', accountHint: openid.slice(-6),
    capturedAt: new Date(start).toISOString(), expiresAt: new Date(start + 3590000).toISOString(), updatedAt: new Date(start).toISOString(),
    ...cipher.encrypt(parseQqAuthorization(document(), start).authorization, 'fixture') };
  const storedRow: Record<string, unknown> = { ...row };
  let mode: 'normal' | 'capacity' | 'overflow' | 'older' | 'failure' = 'normal';
  const queries: { sql: string; values?: unknown[] }[] = [], destroyed: boolean[] = [];
  const pool = { async connect() { return {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      if (sql.includes('current_database()')) return { rows: [{ database: 'naruto_login_test' }] };
      if (sql.includes('CREATE TABLE') || /^(?:BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql)) return { rows: [] };
      if (mode === 'failure') throw new Error(`sensitive driver ${token}`);
      assert.equal(values?.[0], owner);
      if (sql.includes('count(*)')) return { rows: [{ count: mode === 'capacity' ? 200 : 1 }] };
      if (sql.includes('FOR UPDATE')) return { rows: mode === 'older' ? [storedRow] : [] };
      if (sql.includes('LIMIT 201')) return { rows: mode === 'overflow' ? Array(201).fill(storedRow) as Record<string, unknown>[] : [storedRow] };
      return { rows: [storedRow] };
    }, release(destroy?: boolean) { destroyed.push(destroy === true); },
  }; }, async end() {} };
  const store = new PgQqAuthorizationStore(config, { pool });
  assert.equal((await store.get(owner, row.id))?.id, row.id);
  assert.equal((await store.list(owner)).length, 1); assert.equal(await store.delete(owner, row.id), true);
  for (const query of queries.filter(item => item.sql.includes('WHERE'))) assert.match(query.sql, /WHERE owner_id = \$1/);
  mode = 'capacity'; await assert.rejects(store.upsert(row), errorIs(409, 'QQ_AUTHORIZATION_LIMIT'));
  assert(!queries.some(query => query.sql.startsWith('INSERT'))); assert(queries.some(query => query.sql === 'ROLLBACK'));
  mode = 'overflow'; await assert.rejects(store.list(owner), errorIs(409));
  mode = 'older'; assert.equal((await store.upsert({ ...row, capturedAt: new Date(start - 1).toISOString() })).capturedAt, row.capturedAt);
  assert(!queries.some(query => query.sql.startsWith('INSERT')));
  mode = 'failure'; await assert.rejects(store.get(owner, row.id), errorIs(503));
  assert.equal(destroyed.at(-1), true);
});

test('PostgreSQL 初始化先核对真实库名，prod 或错误数据库绝不建表', async () => {
  for (const database of ['naruto_login', 'naruto_login_test']) {
    const queries: string[] = []; let released = false;
    const pool = { async connect() { return { async query(sql: string) { queries.push(sql); return { rows: sql.includes('current_database()') ? [{ database }] : [] }; }, release() { released = true; } }; }, async end() {} };
    const store = new PgQqAuthorizationStore(config, { pool });
    if (database === 'naruto_login') await assert.rejects(store.initialize(), errorIs(503));
    else await store.initialize();
    assert(released); assert.equal(queries.some(sql => sql.includes('CREATE TABLE')), database === 'naruto_login_test');
    assert.equal(queries[0], 'SELECT current_database() AS database');
  }
  assert.throws(() => new PgQqAuthorizationStore({ ...config, appEnv: 'prod' }), errorIs(404));
  assert.throws(() => new PgQqAuthorizationStore({ ...config, databaseUrl: 'postgresql://fixture@db.invalid/naruto_login' }), errorIs(503));
});

test('HTTP API 复用 Cookie 登录，隔离用户，只有授权接口允许大于 2KB 的 JSON', async t => {
  const store = new MemoryStore();
  const service = new QqAuthorizationService(config, { store, now: () => start, verify: async () => {} });
  const unused = async () => { throw new Error('unused'); };
  const auth = { register: unused, login: unused, listApplications: unused, reviewApplication: unused,
    getUser: async (cookie?: string) => cookie === 'one.two.three' ? { id: owner, username: '测试账号', isAdmin: false } : null };
  const deps: Dependencies = { auth, qqAuthorizations: service, events: { create: unused, getForUser: unused, getActive: unused, recordStatus: unused }, storage: { exists: async () => false, read: async () => null } };
  const server = createApp(config, deps).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const headers = { Cookie: 'naruto_session=one.two.three', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/qq-authorizations`)).status, 401);
  const authorization = document({ callback_url: `${document().callback_url}&extra=${'x'.repeat(3000)}` });
  const response = await fetch(`${base}/api/qq-authorizations`, { method: 'POST', headers, body: JSON.stringify({ label: '大回调', authorization }) });
  assert.equal(response.status, 201); const body = await response.json() as { item: { id: string } };
  assert.equal((await fetch(`${base}/api/qq-authorizations/${body.item.id}`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ long: 'x'.repeat(3000) }) })).status, 400);
  assert.equal((await fetch(`${base}/api/qq-authorizations`, { method: 'POST', headers, body: '{"label":"a","label":"b"}' })).status, 400);
  assert.equal((await fetch(`${base}/api/qq-authorizations`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/qq-authorizations/${body.item.id}`, { method: 'DELETE', headers })).status, 204);
});
