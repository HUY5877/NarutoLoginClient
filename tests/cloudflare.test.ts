import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { once } from 'node:events';
import { createRuntimeConfigLoader } from '../src/server/cloudflare.js';
import { loadConfig } from '../src/server/config.js';
import { createApp, type Dependencies } from '../src/server/app.js';
import { cloudflareTestEnv } from './cloudflare-fixture.js';

function kv(values: Record<string, unknown>, calls: URL[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, 'api.cloudflare.com');
    if (url.pathname.endsWith('/keys')) {
      assert.equal(url.searchParams.has('prefix'), false);
      return Response.json({ success: true, result: Object.keys(values).map(name => ({ name })), result_info: { cursor: '' } });
    }
    assert.equal(url.pathname.endsWith('/bulk/get'), true);
    assert.equal(init?.method, 'POST');
    const { keys, type } = JSON.parse(String(init?.body)) as { keys: string[]; type: string };
    assert.equal(type, 'text');
    assert(keys.length <= 100);
    return Response.json({ success: true, result: { values: Object.fromEntries(keys.map(key => [key, values[key]])) } });
  };
}

const controls = {
  PORT: '4300', SESSION_COOKIE_NAME: 'naruto_session', STORAGE_DRIVER: 'local', LOCAL_OBJECTS_DIR: 'fixture-prod',
};
const profiles = {
  prod: { ...controls, REDIS_QUEUE_KEY: 'naruto:login:tasks', OSS_KEY_PREFIX: 'login',
    DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/naruto_login',
    REDIS_URL: 'redis://fixture:fixture@redis.invalid:6379/0', JWT_SECRET: 'p'.repeat(32) },
  test: { ...controls, PORT: '4301', SESSION_COOKIE_NAME: 'naruto_session_test_jev', LOCAL_OBJECTS_DIR: 'fixture-test',
    REDIS_QUEUE_KEY: 'naruto:login-test-jev:tasks', OSS_KEY_PREFIX: 'login-test-jev',
    DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/naruto_login_test',
    REDIS_URL: 'redis://fixture:fixture@redis.invalid:6379/0', JWT_SECRET: 't'.repeat(32) },
};

test('只读取所选独立 namespace，同连接的不同数据库、任务和日志前缀由 KV 决定', async () => {
  for (const profile of ['prod', 'test'] as const) {
    const calls: URL[] = [];
    const loader = createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: profile,
      DATABASE_URL: 'postgresql://obsolete:secret@production.invalid/obsolete',
      REDIS_QUEUE_KEY: 'obsolete:production', OSS_KEY_PREFIX: 'obsolete', PORT: '4400' }, fetch: kv(profiles[profile], calls) });
    const config = await loader();
    assert.equal(config.appEnv, profile);
    assert.equal(config.databaseUrl, profiles[profile].DATABASE_URL);
    assert.equal(config.redisUrl, profiles[profile].REDIS_URL);
    assert.equal(config.redisQueueKey, profiles[profile].REDIS_QUEUE_KEY);
    assert.equal(config.ossPrefix, profiles[profile].OSS_KEY_PREFIX);
    assert.equal(config.port, profile === 'prod' ? 4300 : 4301);
    assert.equal(config.sessionCookieName, profile === 'prod' ? 'naruto_session' : 'naruto_session_test_jev');
    assert.equal(calls.length, 2);
    assert(calls.every(url => url.pathname.includes(`/namespaces/fixture-${profile}/`)));
  }
});

test('默认选择 prod；并发及后续初始化复用同一次完整配置读取', async () => {
  const calls: URL[] = [];
  const { APP_ENV: _, ...env } = cloudflareTestEnv;
  const loader = createRuntimeConfigLoader({ env, fetch: kv(profiles.prod, calls) });
  const [first, second] = await Promise.all([loader(), loader()]);
  assert.equal(first, second);
  assert.equal(first.appEnv, 'prod');
  assert.equal(await loader(), first);
  assert.equal(calls.length, 2);
  assert.match(calls[0].pathname, /\/fixture-prod\/keys$/);
});

test('正式 namespace 可兼容旧引导变量，测试必须显式设置独立 namespace', async () => {
  const { CLOUDFLARE_KV_NAMESPACE_ID_PROD: _, CLOUDFLARE_KV_NAMESPACE_ID_TEST: __, ...legacy } = cloudflareTestEnv;
  const calls: URL[] = [];
  await createRuntimeConfigLoader({ env: legacy, fetch: kv(profiles.prod, calls) })();
  assert(calls.every(url => url.pathname.includes('/namespaces/fixture-namespace/')));
  await assert.rejects(createRuntimeConfigLoader({ env: { ...legacy, APP_ENV: 'test' }, fetch: async () => assert.fail('must not request production namespace') })(), /CLOUDFLARE_KV_NAMESPACE_ID_TEST/);
  for (const env of [
    { ...cloudflareTestEnv, APP_ENV: 'test', CLOUDFLARE_KV_NAMESPACE_ID_TEST: 'fixture-prod' },
    { ...legacy, APP_ENV: 'test', CLOUDFLARE_KV_NAMESPACE_ID_TEST: legacy.CLOUDFLARE_KV_NAMESPACE_ID },
  ]) {
    await assert.rejects(createRuntimeConfigLoader({ env, fetch: async () => assert.fail('must not request shared namespace') })(), /测试 namespace 必须与正式 namespace 不同/);
  }
});

test('测试 namespace 配置缺失时拒绝启动，不回退正式 namespace 或部署进程旧配置', async () => {
  const loader = createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: 'test',
    REDIS_QUEUE_KEY: 'local:prod', OSS_KEY_PREFIX: 'local-prod' },
    fetch: kv({ PROD_REDIS_QUEUE_KEY: 'prod:tasks', PROD_OSS_KEY_PREFIX: 'login' }) });
  await assert.rejects(loader(), /test 缺少 REDIS_QUEUE_KEY/);
  const missingObjects = createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: 'test' },
    fetch: kv({ REDIS_QUEUE_KEY: 'test:tasks' }) });
  await assert.rejects(missingObjects(), /test 缺少 OSS_KEY_PREFIX/);
});

test('业务连接缺失维持未配置状态，远端引导变量不能改变 profile 或读取目标', async () => {
  const calls: URL[] = [];
  const config = await createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: 'test',
    REDIS_URL: profiles.prod.REDIS_URL, DATABASE_URL: profiles.prod.DATABASE_URL, JWT_SECRET: profiles.prod.JWT_SECRET },
    fetch: kv({ ...controls, REDIS_QUEUE_KEY: 'test:tasks', OSS_KEY_PREFIX: 'test-login',
      APP_ENV: 'prod', CLOUDFLARE_API_TOKEN: 'cannot-replace-bootstrap', CLOUDFLARE_KV_NAMESPACE_ID_TEST: 'cannot-replace-namespace' }, calls) })();
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.redisUrl, undefined);
  assert.equal(config.jwtSecret, undefined);
  assert.equal(config.appEnv, 'test');
  assert(calls.every(url => url.pathname.includes('fixture-account/storage/kv/namespaces/fixture-test/')));
});

test('分页列出 namespace 的全部配置，重复游标或无效键列表均拒绝', async () => {
  const cursors: Array<string | null> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/bulk/get')) return kv(profiles.test)(input, init);
    const cursor = url.searchParams.get('cursor');
    cursors.push(cursor);
    return Response.json({ success: true, result: [...(cursor ? ['OSS_KEY_PREFIX'] : ['REDIS_QUEUE_KEY',
      ...Object.keys(controls)])].map(name => ({ name })),
      result_info: { cursor: cursor ? '' : 'next-page' } });
  };
  const config = await createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: 'test' }, fetch: fetcher })();
  assert.equal(config.ossPrefix, profiles.test.OSS_KEY_PREFIX);
  assert.deepEqual(cursors, [null, 'next-page']);
  await assert.rejects(createRuntimeConfigLoader({ env: cloudflareTestEnv,
    fetch: async () => Response.json({ success: true, result: [], result_info: { cursor: 'same-page' } }) })(), /游标重复/);
  await assert.rejects(createRuntimeConfigLoader({ env: cloudflareTestEnv,
    fetch: async () => Response.json({ success: true, result: [{ name: null }] }) })(), /列表格式无效/);
});

test('缺失监听端口、Cookie、存储方式或本地根目录时拒绝启动，不能使用正式默认值', async () => {
  for (const profile of ['prod', 'test'] as const) {
    for (const key of ['PORT', 'SESSION_COOKIE_NAME', 'STORAGE_DRIVER', 'LOCAL_OBJECTS_DIR']) {
      const partial: Record<string, unknown> = { ...profiles[profile] };
      delete partial[key];
      await assert.rejects(createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: profile }, fetch: kv(partial) })(), new RegExp(`缺少 ${key}`));
    }
  }
});

test('缺少引导、无效环境、读取超时及非完整文本值不会发布部分配置或泄漏错误详情', async () => {
  assert.equal(loadConfig({}).appEnv, 'prod');
  assert.equal(loadConfig({ APP_ENV: 'test' }).appEnv, 'test');
  assert.throws(() => loadConfig({ APP_ENV: 'staging' }), /APP_ENV/);
  await assert.rejects(createRuntimeConfigLoader({ env: {} })(), /CLOUDFLARE_API_TOKEN/);
  await assert.rejects(createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: 'staging' } })(), /APP_ENV/);
  let calls = 0;
  const failed = createRuntimeConfigLoader({ env: cloudflareTestEnv, fetch: async () => {
    calls += 1; throw new Error('secret-token-or-url');
  } });
  await assert.rejects(failed(), error => {
    assert(error instanceof Error); assert.match(error.message, /prod 配置读取失败/); assert.doesNotMatch(error.message, /secret-token/); return true;
  });
  await assert.rejects(failed());
  assert.equal(calls, 1);
  await assert.rejects(createRuntimeConfigLoader({ env: cloudflareTestEnv, timeoutMs: 5,
    fetch: async () => new Promise(() => {}) })(), /配置读取失败/);
  await assert.rejects(createRuntimeConfigLoader({ env: cloudflareTestEnv,
    fetch: kv({ REDIS_QUEUE_KEY: null, OSS_KEY_PREFIX: 'login' }) })(), /配置不完整/);
  await assert.rejects(createRuntimeConfigLoader({ env: cloudflareTestEnv,
    fetch: async () => Response.json({ success: false, result: [], errors: [{ message: 'secret' }] }) })(), /配置读取失败/);
});

test('同域正式与测试 Cookie 的读取、写入和退出均使用配置名称', async () => {
  const cookieName = 'fixture_test_session';
  const token = 'header.fixture.signature';
  const received: Array<string | undefined> = [];
  const auth: Dependencies['auth'] = { getUser: async token => { received.push(token); return null; },
    login: async () => ({ user: { id: 'fixture', username: 'fixture', isAdmin: false }, token, expiresAt: new Date(Date.now() + 60000) }),
    register: async () => assert.fail(), listApplications: async () => assert.fail(), reviewApplication: async () => assert.fail() };
  const app = createApp(loadConfig({ APP_ENV: 'test', SESSION_COOKIE_NAME: cookieName,
    JWT_SECRET: 'private-health-fixture-key-32-bytes', DATABASE_URL: 'postgresql://fixture:private@db.invalid/test' }), { auth,
    storage: { exists: async () => false, read: async () => null },
    events: { create: async () => assert.fail(), getActive: async () => null, getForUser: async () => assert.fail(), recordStatus: async () => {} } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, storage: 'local', simulation: true, environment: 'test' });
    await fetch(`${base}/api/auth/me`, { headers: { Cookie: `naruto_session=prod.fixture.signature; ${cookieName}=${token}` } });
    await fetch(`${base}/api/auth/me`, { headers: { Cookie: 'naruto_session=prod.fixture.signature' } });
    assert.deepEqual(received, [token, undefined]);
    for (const action of ['login', 'logout']) {
      const response = await fetch(`${base}/api/auth/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert(response.ok);
      assert.match(response.headers.get('set-cookie') ?? '', new RegExp(`^${cookieName}=`));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.throws(() => loadConfig({ SESSION_COOKIE_NAME: 'unsafe;cookie' }), /SESSION_COOKIE_NAME/);
});
