import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { PgQqCaptureStore, QqCaptureService } from '../src/server/qq-captures.js';
import { parseQqAuthorization, validateQqJson } from '../src/server/qq-authorization-data.js';

const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');

const owner = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const captureId = '30000000-0000-4000-8000-000000000001';
const captureToken = 'a1'.repeat(32);
const start = Date.parse('2026-10-24T02:00:00Z');
const document = () => ({ schema_version: 1, app_id: '1104307008', captured_at_epoch_ms: start,
  callback_url: `auth://tauth.qq.com/#ret=0&access_token=${'12'.repeat(16)}&openid=${'34'.repeat(16)}&expires_in=3600` });
const upload = () => ({ userId: owner, taskId, attemptId: 'ab'.repeat(16), captureId, captureToken, authorization: document() });
const other = '10000000-0000-4000-8000-000000000002';
const secondCapture = '30000000-0000-4000-8000-000000000002';
const config = { databaseUrl: 'postgresql://fixture:fixture@db.invalid/fixture', timeoutMs: 1000 };
const errorIs = (status: number, code?: string) => (error: unknown) => {
  assert(error instanceof ApiError); assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert(!error.message.includes(captureToken)); assert(!error.message.includes(document().callback_url)); return true;
};

async function database(t: { after(fn: () => Promise<void>): void }) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users (id uuid PRIMARY KEY);
    CREATE TABLE naruto_login.login_events (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES naruto_login.users(id));`);
  await db.query('INSERT INTO naruto_login.users VALUES ($1),($2)', [owner, other]);
  await db.query('INSERT INTO naruto_login.login_events VALUES ($1,$2)', [taskId, owner]);
  const pool = { async connect() { return { async query(sql: string, values?: unknown[]) {
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows };
  }, release() {} }; }, async end() {} };
  const store = new PgQqCaptureStore(config, { pool }); await store.initialize();
  const service = new QqCaptureService(config, { store });
  const input = { ...upload(), authorization: { ...document(), captured_at_epoch_ms: Date.now() - 5000 } };
  const begin = async (value = input, loginType = 'android_qq') => {
    await db.query(`INSERT INTO naruto_login.qq_capture_requests
      (task_id,owner_id,attempt_id,capture_id,capture_token_hash,login_type,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')`,
    [value.taskId, value.userId, value.attemptId, value.captureId, createHash('sha256').update(value.captureToken).digest('hex'), loginType]);
  };
  return { db, store, service, input, begin };
}

test('抓号上传以任务凭证校验且无需网站会话，历史列表仍要求登录', async () => {
  const calls: unknown[] = [];
  const dependencies = {
    events: {}, storage: {}, auth: { getUser: async () => null },
    qqCaptures: { upload: async (body: unknown) => { calls.push(body); return { item: { label: '自己账号' } }; }, list: async () => ({ items: [] }) },
  } as unknown as Dependencies;
  const server = createApp(loadConfig({}), dependencies).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/qq-captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(upload()) });
    assert.equal(response.status, 201);
    assert.deepEqual(calls, [upload()]);
    assert.equal((await fetch(`${base}/api/qq-authorizations`)).status, 401);
    const duplicate = await fetch(`${base}/api/qq-captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"userId":"one","userId":"two"}' });
    assert.equal(duplicate.status, 400);
    const crossSite = await fetch(`${base}/api/qq-captures`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: JSON.stringify(upload()) });
    assert.equal(crossSite.status, 403);
    assert.equal(calls.length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('QQ申请入队前建好抓号表，微信沿用原有入队路径，历史归属只使用登录身份', async () => {
  const calls: string[] = [];
  const dependencies = {
    events: { create: async (_owner: string, _request: string, _options: unknown, loginType: string) => {
      calls.push(`create:${loginType}`); return { id: taskId, status: 'queued', expiresAt: new Date(Date.now() + 60000).toISOString() };
    } }, storage: {}, auth: { getUser: async () => ({ id: owner, username: 'fixture' }) },
    qqCaptures: { initialize: async () => { calls.push('initialize'); }, list: async (ownerId: string) => {
      calls.push(`list:${ownerId}`); return { items: [] };
    } },
  } as unknown as Dependencies;
  const server = createApp(loadConfig({}), dependencies).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const loginType of ['android_qq', 'ios_qq', 'android_wechat', 'ios_wechat']) {
      const response = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginType }) });
      assert.equal(response.status, 202);
    }
    assert.deepEqual(calls, ['initialize', 'create:android_qq', 'initialize', 'create:ios_qq', 'create:android_wechat', 'create:ios_wechat']);
    assert.equal((await fetch(`${base}/api/qq-authorizations?userId=${other}`)).status, 200);
    assert.equal(calls.at(-1), `list:${owner}`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('完整回调本地解析保留URL且按原始授权时间计算期限，拒绝歧义字段和过期授权', () => {
  const value = { ...document(), callback_url: `${document().callback_url}&auth_time=${start - 10000}&pf=openmobile_ios&pfkey=keep&pay_token=kept` };
  const parsed = parseQqAuthorization(value, start);
  assert.equal(parsed.expiresAt, start + 3590000);
  assert.equal(parsed.authorization.callback_url, value.callback_url);
  for (const callback_url of [document().callback_url.replace('auth://', 'https://'), `${document().callback_url}&%72et=0`,
    `${document().callback_url}&extra=%0A`, `${document().callback_url}&appid=wrong`, document().callback_url.replace('ret=0', 'ret=1')]) {
    assert.throws(() => parseQqAuthorization({ ...document(), callback_url }, start), errorIs(400));
  }
  assert.throws(() => parseQqAuthorization(document(), start + 3600000), errorIs(410));
  assert.throws(() => validateQqJson('{"userId":"one","userId":"two"}'), errorIs(400));
});

test('PostgreSQL保存两类QQ渠道的任务授权，网站历史按本人隔离且不返回任何凭据', async t => {
  const { db, store, service, input, begin } = await database(t);
  await begin(input);
  const first = await service.upload(input);
  assert.equal(first.captureId, captureId); assert.equal(first.item?.label, '自己账号');
  assert.equal(first.item?.appId, '1104307008'); assert.equal(first.item?.accountHint, '343434');
  const row = (await db.query('SELECT * FROM naruto_login.qq_capture_requests')).rows[0] as Record<string, unknown>;
  assert.equal(row.status, 'completed'); assert.equal(row.callback_url, input.authorization.callback_url);
  assert.equal(row.authorization_hash, createHash('sha256').update(input.authorization.callback_url).digest('hex'));
  const secondTask = '20000000-0000-4000-8000-000000000002';
  await db.query('INSERT INTO naruto_login.login_events VALUES ($1,$2)', [secondTask, other]);
  const second = { ...input, userId: other, taskId: secondTask, captureId: secondCapture };
  await begin(second, 'ios_qq'); await service.upload(second);
  const own = await service.list(owner), theirs = await service.list(other);
  assert.equal(own.items.length, 1); assert.equal(theirs.items.length, 1); assert.notEqual(own.items[0].id, theirs.items[0].id);
  for (const result of [own, theirs, first]) {
    const json = JSON.stringify(result);
    for (const secret of ['callback_url', 'access_token', 'openid', 'tokenHash', captureToken, input.authorization.callback_url]) assert(!json.includes(secret));
  }
  const before = await db.query('SELECT * FROM naruto_login.qq_authorizations ORDER BY id');
  await new PgQqCaptureStore(config, { pool: { connect: async () => ({ query: async (sql, values) => {
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!; return { rows: result.rows };
  }, release() {} }), end: async () => {} } }).initialize();
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_authorizations ORDER BY id')).rows, before.rows);
  await store.close();
});

test('PostgreSQL拒绝跨用户、任务、attempt、刷新轮次和错误凭证，公开userid不能单独写入', async t => {
  const { db, service, input, begin } = await database(t); await begin();
  for (const changed of [{ userId: other }, { taskId: '20000000-0000-4000-8000-000000000099' },
    { attemptId: 'cd'.repeat(16) }, { captureId: secondCapture }, { captureToken: 'ff'.repeat(32) }]) {
    await assert.rejects(service.upload({ ...input, ...changed }), errorIs(403, 'QQ_CAPTURE_FORBIDDEN'));
  }
  for (const value of [{ userId: owner, authorization: input.authorization }, { ...input, label: '伪造备注' },
    { ...input, captureToken: '' }, { ...input, attemptId: 'not-an-attempt' }]) await assert.rejects(service.upload(value), errorIs(400));
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_authorizations')).rows.length, 0);
  assert.equal((await db.query<{ status: string }>('SELECT status FROM naruto_login.qq_capture_requests')).rows[0].status, 'pending');
  await assert.rejects(db.query(`UPDATE naruto_login.qq_capture_requests SET login_type = 'ios_wechat'`));
});

test('PostgreSQL刷新和新attempt隔离旧回调，消费后同回调重试不会重新发布', async t => {
  const { db, service, input, begin } = await database(t); await begin();
  await service.upload(input);
  await db.query(`UPDATE naruto_login.qq_capture_requests SET status = 'consumed', callback_url = NULL WHERE task_id = $1 AND attempt_id = $2`, [taskId, input.attemptId]);
  assert.deepEqual(await service.upload(input), { captureId });
  assert.equal((await db.query<{ status: string; callback_url: string | null }>('SELECT status,callback_url FROM naruto_login.qq_capture_requests')).rows[0].callback_url, null);
  await assert.rejects(service.upload({ ...input, authorization: { ...input.authorization,
    callback_url: input.authorization.callback_url.replace('access_token=12', 'access_token=56') } }), errorIs(409));
  const refreshed = { ...input, captureId: secondCapture, captureToken: 'b2'.repeat(32) };
  await db.query(`UPDATE naruto_login.qq_capture_requests SET capture_id=$1,capture_token_hash=$2,status='pending',
    authorization_hash=NULL,callback_url=NULL,captured_at=NULL,authorization_expires_at=NULL WHERE task_id=$3 AND attempt_id=$4`,
  [refreshed.captureId, createHash('sha256').update(refreshed.captureToken).digest('hex'), taskId, input.attemptId]);
  await assert.rejects(service.upload(input), errorIs(403));
  const nextAttempt = { ...input, attemptId: 'cd'.repeat(16), captureId: '30000000-0000-4000-8000-000000000003' };
  await begin(nextAttempt);
  await service.upload(refreshed);
  const rows = (await db.query('SELECT attempt_id,status FROM naruto_login.qq_capture_requests ORDER BY attempt_id')).rows;
  assert.deepEqual(rows, [{ attempt_id: input.attemptId, status: 'completed' }, { attempt_id: nextAttempt.attemptId, status: 'pending' }]);
  await service.upload(nextAttempt);
  assert.equal((await service.list(owner)).items.length, 1);
});

test('PostgreSQL已取消或过期任务拒绝上传，完成保存期间到期会回滚账户和交付', async t => {
  const { db, service, input, begin } = await database(t); await begin();
  await db.query("UPDATE naruto_login.qq_capture_requests SET status='cancelled'");
  await assert.rejects(service.upload(input), errorIs(410));
  await db.query("UPDATE naruto_login.qq_capture_requests SET status='pending',expires_at=clock_timestamp()-interval '1 second'");
  await assert.rejects(service.upload(input), errorIs(410));
  await db.query("UPDATE naruto_login.qq_capture_requests SET expires_at=clock_timestamp()+interval '10 minutes'");
  await db.exec(`CREATE FUNCTION expire_capture_after_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE naruto_login.qq_capture_requests SET expires_at=clock_timestamp()-interval '1 second'; RETURN NEW; END $$;
    CREATE TRIGGER capture_deadline AFTER INSERT ON naruto_login.qq_authorizations
      FOR EACH ROW EXECUTE FUNCTION expire_capture_after_account();`);
  await assert.rejects(service.upload(input), errorIs(410));
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_authorizations')).rows.length, 0);
  const request = (await db.query<{ status: string; callback_url: string | null }>('SELECT status, callback_url FROM naruto_login.qq_capture_requests')).rows[0];
  assert.equal(request.status, 'pending'); assert.equal(request.callback_url, null);
});
