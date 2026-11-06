import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { QqAuthorizationCipher } from '../src/server/qq-authorization-data.js';
import { PgQqAuthorizationStore, QqAuthorizationService } from '../src/server/qq-authorizations.js';
import { PgQqCaptureStore, QqCaptureService } from '../src/server/qq-captures.js';

const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
const owner = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const recordId = '30000000-0000-4000-8000-000000000001';
const captureId = '40000000-0000-4000-8000-000000000001';
const key = '17'.repeat(32);
const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/naruto_login_test',
  QQ_AUTHORIZATION_ENCRYPTION_KEY: key });
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503;

// Historical encrypted schema, independent of the current stores' generated DDL.
const oldSchema = `CREATE TABLE naruto_login.qq_authorizations (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  app_id text NOT NULL CHECK (app_id = '1104307008'),
  openid_fingerprint text NOT NULL CHECK (openid_fingerprint ~ '^[0-9a-f]{64}$'),
  label text NOT NULL, account_hint text NOT NULL,
  captured_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at > captured_at),
  updated_at timestamptz NOT NULL, ciphertext bytea NOT NULL, nonce bytea NOT NULL, auth_tag bytea NOT NULL,
  encryption_version smallint NOT NULL DEFAULT 1 CHECK (encryption_version = 1),
  UNIQUE(owner_id, app_id, openid_fingerprint)
);
CREATE INDEX qq_authorizations_owner_updated_idx ON naruto_login.qq_authorizations (owner_id, updated_at DESC, id);`;

async function fixture(t: TestContext, databaseName = 'naruto_login_test') {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE SCHEMA naruto_login;
    CREATE TABLE naruto_login.users (id uuid PRIMARY KEY);
    CREATE TABLE naruto_login.login_events (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES naruto_login.users(id));`);
  await db.query('INSERT INTO naruto_login.users VALUES ($1)', [owner]);
  await db.query('INSERT INTO naruto_login.login_events VALUES ($1,$2)', [taskId, owner]);
  const pool = { async connect() { return { async query(sql: string, values?: unknown[]) {
    // PGlite has a fixed database name. Only the test-instance identity is adapted;
    // every schema operation, transaction and business query runs in PostgreSQL.
    if (sql === 'SELECT current_database() AS database') return { rows: [{ database: databaseName }] };
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows };
  }, release() {} }; }, async end() {} };
  const captureStore = (appEnv: 'test' | 'prod' = 'test') => new PgQqCaptureStore({ ...config, appEnv }, { pool });
  const authorizationStore = () => new PgQqAuthorizationStore(config, { pool });
  async function tables() {
    return (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'naruto_login' ORDER BY tablename`)).rows;
  }
  async function insertOld() {
    await db.exec(oldSchema);
    await db.query(`INSERT INTO naruto_login.qq_authorizations
      (id,owner_id,app_id,openid_fingerprint,label,account_hint,captured_at,expires_at,updated_at,ciphertext,nonce,auth_tag)
      VALUES ($1,$2,'1104307008',$3,'旧账号','343434','2026-10-23T02:00:00Z','2026-10-23T03:00:00Z',
        '2026-10-23T02:00:00Z',$4,$5,$6)`,
    [recordId, owner, 'ab'.repeat(32), Buffer.from([1, 2, 3, 4]), Buffer.from('11'.repeat(12), 'hex'), Buffer.from('22'.repeat(16), 'hex')]);
    return (await db.query('SELECT * FROM naruto_login.qq_authorizations')).rows;
  }
  return { db, pool, captureStore, authorizationStore, tables, insertOld };
}

test('合并后首次抓号初始化保留旧密文记录和身份，旧表及索引移动后新表可独立使用', async t => {
  const f = await fixture(t);
  const before = await f.insertOld();
  await f.captureStore().initialize();
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations_encrypted')).rows, before);
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows, []);
  const columns = (await f.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'naruto_login' AND table_name = 'qq_authorizations'`)).rows.map(row => row.column_name);
  for (const name of ['access_token', 'openid', 'callback_url']) assert(columns.includes(name));
  assert(!columns.includes('ciphertext'));
  const indexes = (await f.db.query<{ tablename: string; indexname: string; indexdef: string }>(`SELECT tablename,indexname,indexdef
    FROM pg_indexes WHERE schemaname = 'naruto_login' AND indexdef LIKE '%owner_id, updated_at DESC, id)%' ORDER BY tablename`)).rows;
  assert.deepEqual(indexes.map(row => row.tablename), ['qq_authorizations', 'qq_authorizations_encrypted']);
  assert.notEqual(indexes[0].indexname, indexes[1].indexname);
  // Repeated startup must not rename or rewrite the already separated records.
  await f.captureStore().initialize();
  await f.authorizationStore().initialize();
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations_encrypted')).rows, before);
});

test('合并初始化保留已有明文抓号记录和原始回调，不因旧授权服务启用而改写', async t => {
  const f = await fixture(t);
  await f.captureStore().initialize();
  await f.db.query(`INSERT INTO naruto_login.qq_authorizations
    (id,owner_id,app_id,openid_fingerprint,label,account_hint,captured_at,expires_at,updated_at,access_token,openid,callback_url)
    VALUES ($1,$2,'1104307008',$3,'已有抓号','343434','2026-10-24T02:00:00Z','2026-10-24T03:00:00Z',
      '2026-10-24T02:00:00Z',$4,$5,$6)`,
  [recordId, owner, 'ab'.repeat(32), '12'.repeat(16), '34'.repeat(16), 'auth://tauth.qq.com/#historical-fixture']);
  const before = (await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows;
  await f.authorizationStore().initialize();
  await f.captureStore().initialize();
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows, before);
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations_encrypted')).rows, []);
});

for (const kind of ['unknown', 'mixed', 'duplicate'] as const) {
  test(`合并初始化拒绝${kind === 'unknown' ? '未知' : kind === 'mixed' ? '混合' : '两个旧密文'}表结构并回滚全部变更`, async t => {
    const f = await fixture(t);
    if (kind === 'unknown') {
      await f.db.exec('CREATE TABLE naruto_login.qq_authorizations (id text PRIMARY KEY, retained text NOT NULL);');
      await f.db.query('INSERT INTO naruto_login.qq_authorizations VALUES ($1,$2)', ['fixture-id', '需要完整保留']);
    } else {
      await f.insertOld();
      if (kind === 'mixed') await f.db.exec('ALTER TABLE naruto_login.qq_authorizations ADD COLUMN access_token text;');
      else await f.db.exec('CREATE TABLE naruto_login.qq_authorizations_encrypted (LIKE naruto_login.qq_authorizations INCLUDING ALL);');
    }
    const beforeTables = await f.tables();
    const beforeRows = (await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows;
    await assert.rejects(f.captureStore().initialize(), unavailable);
    assert.deepEqual(await f.tables(), beforeTables);
    assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows, beforeRows);
  });
}

test('正式环境遇到旧密文表时拒绝初始化，原表原记录和索引保持不变', async t => {
  const f = await fixture(t);
  const before = await f.insertOld(), beforeTables = await f.tables();
  const indexes = (await f.db.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname = 'naruto_login' ORDER BY indexname`)).rows;
  await assert.rejects(f.captureStore('prod').initialize(), unavailable);
  assert.deepEqual(await f.tables(), beforeTables);
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows, before);
  assert.deepEqual((await f.db.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname = 'naruto_login' ORDER BY indexname`)).rows, indexes);
});

test('测试环境误连正式数据库时不能迁移旧密文表，原记录与表名保持不变', async t => {
  const f = await fixture(t, 'naruto_login');
  const before = await f.insertOld(), beforeTables = await f.tables();
  await assert.rejects(f.captureStore('test').initialize(), unavailable);
  assert.deepEqual(await f.tables(), beforeTables);
  assert.deepEqual((await f.db.query('SELECT * FROM naruto_login.qq_authorizations')).rows, before);
});

for (const first of ['legacy', 'capture'] as const) {
  test(`合并后${first === 'legacy' ? '旧授权' : '新抓号'}先初始化，两套服务都可上传且不混用凭据`, async t => {
    const f = await fixture(t);
    const legacyStore = f.authorizationStore(), captureStore = f.captureStore();
    if (first === 'legacy') { await legacyStore.initialize(); await captureStore.initialize(); }
    else { await captureStore.initialize(); await legacyStore.initialize(); }
    const capturedAt = Date.now() - 5000;
    const authorization = { schema_version: 1, app_id: '1104307008', captured_at_epoch_ms: capturedAt,
      callback_url: `auth://tauth.qq.com/#ret=0&access_token=${'12'.repeat(16)}&openid=${'34'.repeat(16)}&expires_in=3600&pfkey=retained` };
    const legacy = new QqAuthorizationService(config, { store: legacyStore, verify: async () => {} });
    const saved = await legacy.upload(owner, { label: '手动保存账号', authorization });
    assert.equal(saved.item.label, '手动保存账号');
    assert.deepEqual((await legacy.get(owner, saved.item.id)).authorization, authorization);
    const captureToken = 'a1'.repeat(32), attemptId = 'ab'.repeat(16);
    await f.db.query(`INSERT INTO naruto_login.qq_capture_requests
      (task_id,owner_id,attempt_id,capture_id,capture_token_hash,login_type,expires_at)
      VALUES ($1,$2,$3,$4,$5,'android_qq',clock_timestamp()+interval '10 minutes')`,
    [taskId, owner, attemptId, captureId, createHash('sha256').update(captureToken).digest('hex')]);
    const capture = new QqCaptureService(config, { store: captureStore });
    const captured = await capture.upload({ userId: owner, taskId, attemptId, captureId, captureToken, authorization });
    assert.equal(captured.captureId, captureId);
    assert.equal((await capture.list(owner)).items.length, 1);
    assert.equal((await legacy.list(owner)).items.length, 1);
    const encrypted = (await f.db.query<{ ciphertext: Uint8Array; nonce: Uint8Array; auth_tag: Uint8Array }>(
      'SELECT ciphertext,nonce,auth_tag FROM naruto_login.qq_authorizations_encrypted')).rows[0];
    assert.equal(encrypted.nonce.length, 12);
    assert(!Buffer.from(encrypted.ciphertext).includes(Buffer.from(authorization.callback_url)));
    const plain = (await f.db.query<{ callback_url: string }>('SELECT callback_url FROM naruto_login.qq_authorizations')).rows;
    assert.deepEqual(plain, [{ callback_url: authorization.callback_url }]);
    const cipher = new QqAuthorizationCipher(key);
    const fingerprint = cipher.fingerprint(owner, '34'.repeat(16));
    assert.deepEqual(cipher.decrypt({ ciphertext: Buffer.from(encrypted.ciphertext), nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.auth_tag) }, `${owner}:1104307008:${fingerprint}`), authorization);
    await legacy.delete(owner, saved.item.id);
    assert.equal((await legacy.list(owner)).items.length, 0);
    assert.equal((await capture.list(owner)).items.length, 1);
  });
}

const metadata = (id: string, label: string, updatedAt: string) => ({
  id, label, accountHint: '343434', capturedAt: '2026-10-24T02:00:00.000Z',
  expiresAt: '2026-10-24T03:00:00.000Z', updatedAt, expired: true,
});
async function httpFixture(t: TestContext, dependencies: Dependencies, appConfig = config) {
  const server = createApp(appConfig, dependencies).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const ownUser = { id: owner, username: '虚构账号', isAdmin: false };

test('合并列表只读取登录本人两种来源，按更新时间排序且只公开账号元数据', async t => {
  const oldItem = metadata(recordId, '手动保存', '2026-10-24T03:00:00.000Z');
  const olderItem = metadata('30000000-0000-4000-8000-000000000002', '较早抓号', '2026-10-24T02:30:00.000Z');
  const latestItem = metadata('30000000-0000-4000-8000-000000000003', '较新抓号', '2026-10-24T03:30:00.000Z');
  const requestedOwners: string[] = [];
  const dependencies = { events: {}, storage: {}, auth: { getUser: async (cookie: string) => cookie === 'one.two.three' ? ownUser : null },
    qqAuthorizations: { isConfigured: () => true, list: async (id: string) => { requestedOwners.push(id); return { items: [oldItem] }; } },
    qqCaptures: { list: async (id: string) => { requestedOwners.push(id); return { items: [olderItem, latestItem] }; } },
  } as unknown as Dependencies;
  const base = await httpFixture(t, dependencies);
  assert.equal((await fetch(`${base}/api/qq-authorizations`)).status, 401);
  const response = await fetch(`${base}/api/qq-authorizations?userId=10000000-0000-4000-8000-000000000099`,
    { headers: { Cookie: 'naruto_session=one.two.three' } });
  assert.equal(response.status, 200);
  const result = await response.json() as { items: Array<Record<string, unknown>> };
  assert.deepEqual(result.items, [latestItem, oldItem, olderItem]);
  assert.deepEqual(requestedOwners.sort(), [owner, owner]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(result), /callback_url|access_token|openid|ciphertext|nonce|auth_tag|captureToken/);
});

test('正式环境账号列表仅使用抓号历史，不检查或调用测试专用旧授权服务', async t => {
  const captured = metadata(recordId, '正式抓号', '2026-10-24T03:00:00.000Z');
  const dependencies = { events: {}, storage: {}, auth: { getUser: async () => ownUser },
    qqAuthorizations: { isConfigured: () => assert.fail('正式环境不得访问旧授权配置'),
      list: async () => assert.fail('正式环境不得读取旧授权表') },
    qqCaptures: { list: async (id: string) => { assert.equal(id, owner); return { items: [captured] }; } },
  } as unknown as Dependencies;
  const base = await httpFixture(t, dependencies, { ...config, appEnv: 'prod' });
  const response = await fetch(`${base}/api/qq-authorizations`, { headers: { Cookie: 'naruto_session=one.two.three' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [captured] });
});

test('测试环境缺少旧密钥时不读取旧授权表，已有抓号历史仍正常返回', async t => {
  const captured = metadata(recordId, '无需旧密钥的抓号', '2026-10-24T03:00:00.000Z');
  const dependencies = { events: {}, storage: {}, auth: { getUser: async () => ownUser },
    qqAuthorizations: { isConfigured: () => false, list: async () => assert.fail('未配置旧密钥时不得读取旧授权表') },
    qqCaptures: { list: async (id: string) => { assert.equal(id, owner); return { items: [captured] }; } },
  } as unknown as Dependencies;
  const base = await httpFixture(t, dependencies, { ...config, qqAuthorizationEncryptionKey: undefined });
  const response = await fetch(`${base}/api/qq-authorizations`, { headers: { Cookie: 'naruto_session=one.two.three' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [captured] });
});

test('测试环境旧密钥格式错误不影响抓号历史，旧授权写入仍明确报告配置错误', async t => {
  const invalidConfig = { ...config, qqAuthorizationEncryptionKey: 'bad' };
  const captured = metadata(recordId, '保持可用的抓号', '2026-10-24T03:00:00.000Z');
  const dependencies = { events: {}, storage: {}, auth: { getUser: async () => ownUser },
    qqAuthorizations: new QqAuthorizationService(invalidConfig),
    qqCaptures: { list: async () => ({ items: [captured] }) },
  } as unknown as Dependencies;
  const base = await httpFixture(t, dependencies, invalidConfig);
  const headers = { Cookie: 'naruto_session=one.two.three', 'Content-Type': 'application/json' };
  const response = await fetch(`${base}/api/qq-authorizations`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [captured] });
  const upload = await fetch(`${base}/api/qq-authorizations`, { method: 'POST', headers, body: '{}' });
  assert.equal(upload.status, 503);
  assert.equal((await upload.json() as { code: string }).code, 'QQ_AUTHORIZATION_UNAVAILABLE');
});
