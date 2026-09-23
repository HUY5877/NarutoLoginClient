import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { AuthService, type AuthSession, type User } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { TaskService, type Submission, type Task } from '../src/server/queue.js';

const config = loadConfig({});
const id = '123e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(64);
const otherToken = 'b'.repeat(64);
const user: User = { id: '456e7890-e89b-42d3-a456-426614174000', username: 'naruto' };
const otherUser: User = { id: '456e7890-e89b-42d3-a456-426614174001', username: 'sasuke' };
const start = Date.now();
const baseTask: Task = { id, status: 'opening_game', createdAt: new Date(start).toISOString(),
  expiresAt: new Date(start + 120000).toISOString(), simulation: true };
const authSession: AuthSession = { user, token, expiresAt: new Date(start + 604800000) };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const headers = { Cookie: `naruto_session=${token}` };
const otherHeaders = { Cookie: `naruto_session=${otherToken}` };
const jsonHeaders = { 'Content-Type': 'application/json' };
const post = { method: 'POST', headers: { ...headers, ...jsonHeaders }, body: '{}' };

function tasks(overrides: Partial<Dependencies['tasks']> = {}): Dependencies['tasks'] {
  return { enqueue: async () => {}, getForUser: async () => ({ ...baseTask }), getActive: async () => null, ...overrides };
}
function auth(overrides: Partial<Dependencies['auth']> = {}): Dependencies['auth'] {
  return { register: async () => authSession, login: async () => authSession, logout: async () => {},
    getUser: async value => value === token ? user : value === otherToken ? otherUser : null, ...overrides };
}
async function withApi(deps: Partial<Dependencies>, run: (base: string) => Promise<void>, trustProxy = false) {
  const app = createApp(config, { tasks: tasks(), auth: auth(),
    storage: { exists: async () => false, read: async () => png }, now: () => start, ...deps });
  if (trustProxy) app.set('trust proxy', 1);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('入队身份来自 Cookie，随机 ID/内部凭证由服务端生成，凭证不返回客户端', async () => {
  const submitted: Submission[] = [];
  await withApi({ tasks: tasks({ enqueue: async task => { submitted.push(task); } }) }, async base => {
    const results = await Promise.all([{ headers, owner: user }, { headers: otherHeaders, owner: otherUser }].map(async account => {
      const response = await fetch(`${base}/api/login-sessions`, { ...post, headers: { ...account.headers, ...jsonHeaders },
        body: JSON.stringify({ userId: 'forged-user', id, accessToken: 'forged-token' }) });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as Task & Record<string, unknown>;
      assert.equal(Object.hasOwn(body, 'accessToken'), false);
      assert.equal(Object.hasOwn(body, 'userId'), false);
      assert.equal(body.status, 'queued');
      assert.equal(body.simulation, true);
      assert.equal(Date.parse(body.expiresAt) - Date.parse(body.createdAt), 120000);
      return { body, owner: account.owner };
    }));
    assert.equal(submitted.length, 2);
    assert.notEqual(results[0].body.id, results[1].body.id);
    assert.notEqual(submitted[0].accessToken, submitted[1].accessToken);
    for (const result of results) {
      const queued = submitted.find(task => task.id === result.body.id);
      assert(queued);
      assert.match(queued.accessToken, /^[a-f0-9]{64}$/);
      assert.notEqual(queued.id, id);
      assert.equal(queued.userId, result.owner.id);
      assert.equal(queued.createdAt, result.body.createdAt);
      assert.equal(queued.expiresAt, result.body.expiresAt);
    }
  });
});

test('队列失败不泄露内部错误，账号冲突透传 409', async () => {
  await withApi({ tasks: tasks({ enqueue: async () => { throw new Error('secret sdk path'); } }) }, async base => {
    const response = await fetch(`${base}/api/login-sessions`, post);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret sdk path/);
  });
  await withApi({ tasks: tasks({ enqueue: async () => { throw new ApiError(409, '已有登录申请', 'ACTIVE_LOGIN_SESSION'); } }) }, async base => {
    const response = await fetch(`${base}/api/login-sessions`, post);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: '已有登录申请', code: 'ACTIVE_LOGIN_SESSION' });
  });
});

test('全部写接口拒绝跨站请求，同源页面可以申请登录', async () => {
  const crossSiteHeaders: Record<string, string>[] = [{ Origin: 'https://unrelated.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
  await withApi({}, async base => {
    for (const path of ['/api/login-sessions', '/api/auth/register', '/api/auth/login', '/api/auth/logout']) {
      for (const extra of crossSiteHeaders) {
        const denied = await fetch(`${base}${path}`, { ...post, headers: { ...post.headers, ...extra } });
        assert.equal(denied.status, 403, path);
      }
    }
    assert.equal((await fetch(`${base}/api/login-sessions`, { ...post, headers: { ...post.headers, Origin: 'http://127.0.0.1:5173' } })).status, 403);
    assert.equal((await fetch(`${base}/api/login-sessions`, { ...post, headers: { ...post.headers, Origin: base } })).status, 202);
  });
});

test('全部写接口要求 JSON 内容类型，拒绝表单、文本和缺失类型', async () => {
  const unexpected = async (): Promise<never> => assert.fail('unsupported content types must not invoke a write');
  await withApi({ auth: auth({ register: unexpected, login: unexpected, logout: unexpected }), tasks: tasks({ enqueue: unexpected }) }, async base => {
    for (const path of ['/api/login-sessions', '/api/auth/register', '/api/auth/login', '/api/auth/logout']) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
        assert.equal((await fetch(`${base}${path}`, { ...post, headers: { ...headers, 'Content-Type': type } })).status, 415, path);
      }
      assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers })).status, 415, path);
    }
  });
});

test('注册和登录设置 HttpOnly/Lax Cookie，响应只返回公开用户信息', async () => {
  const input = { username: user.username, password: 'correct-password' };
  const seen: unknown[] = [];
  const accept = async (body: unknown) => { seen.push(body); return authSession; };
  await withApi({ auth: auth({ register: accept, login: accept }) }, async base => {
    for (const [path, status] of [['register', 201], ['login', 200]] as const) {
      const response = await fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { user });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie') ?? '';
      assert.match(cookie, new RegExp(`^naruto_session=${token};`));
      assert.match(cookie, /; HttpOnly(?:;|$)/);
      assert.match(cookie, /; SameSite=Lax(?:;|$)/);
      assert.match(cookie, /; Path=\/(?:;|$)/);
      assert.doesNotMatch(cookie, /; Secure(?:;|$)/);
    }
    assert.deepEqual(seen, [input, input]);
  });
});

test('受信代理转发 HTTPS 时账户 Cookie 带 Secure', async () => {
  await withApi({}, async base => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { ...jsonHeaders, 'X-Forwarded-Proto': 'https', Origin: base.replace('http:', 'https:') },
      body: JSON.stringify({ username: user.username, password: 'correct-password' }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') ?? '', /; Secure(?:;|$)/);
  }, true);
});

test('退出撤销服务端会话并清除 Cookie，原 Cookie 无法继续申请二维码', async () => {
  let revoked = false;
  await withApi({ auth: auth({ getUser: async value => !revoked && value === token ? user : null,
    logout: async value => { assert.equal(value, token); revoked = true; } }) }, async base => {
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`, { headers })).json(), { user });
    const response = await fetch(`${base}/api/auth/logout`, post);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^naruto_session=;/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
    assert.equal(revoked, true);
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`, { headers })).json(), { user: null });
    const denied = await fetch(`${base}/api/login-sessions`, post);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as { code: string }).code, 'AUTH_REQUIRED');
  });
});

test('缺失或无效 Cookie 及仅 Bearer 不能访问二维码接口，且不访问 Redis/OSS', async () => {
  const unexpected = async (): Promise<never> => assert.fail('unauthenticated requests must not touch tasks or storage');
  const attempts: Record<string, string>[] = [{}, { Authorization: `Bearer ${token}` },
    { Cookie: 'naruto_session=invalid' }, { Cookie: `naruto_session=${'c'.repeat(64)}` }];
  await withApi({ tasks: { enqueue: unexpected, getForUser: unexpected, getActive: unexpected }, storage: { exists: unexpected, read: unexpected } }, async base => {
    for (const requestHeaders of attempts) {
      for (const path of ['/api/login-sessions/active', `/api/login-sessions/${id}`, `/api/login-sessions/${id}/qr`]) {
        const response = await fetch(`${base}${path}`, { headers: requestHeaders });
        assert.equal(response.status, 401, path);
        assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
      }
      const created = await fetch(`${base}/api/login-sessions`, { ...post, headers: { ...jsonHeaders, ...requestHeaders } });
      assert.equal(created.status, 401);
      assert.equal((await created.json() as { code: string }).code, 'AUTH_REQUIRED');
    }
  });
});

test('跨账号读取返回 404 且不访问 OSS，active 查询只恢复当前账号申请', async () => {
  const ownedTasks = tasks({ getForUser: async (requestedId, userId) => {
    assert.equal(requestedId, id);
    if (userId !== user.id) throw new ApiError(404, 'not found');
    return baseTask;
  }, getActive: async userId => userId === user.id ? baseTask : null });
  await withApi({ tasks: ownedTasks, storage: { exists: async () => assert.fail('must not probe'), read: async () => assert.fail('must not read') } }, async base => {
    for (const suffix of ['', '/qr']) assert.equal((await fetch(`${base}/api/login-sessions/${id}${suffix}`, { headers: otherHeaders })).status, 404);
    const active = await fetch(`${base}/api/login-sessions/active`, { headers: otherHeaders });
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { session: null });
  });
  await withApi({ tasks: ownedTasks }, async base => {
    const active = await fetch(`${base}/api/login-sessions/active`, { headers });
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { session: baseTask });
  });
});

test('授权通过后直接检查对象存储，文件已到达即返回就绪', async () => {
  let probes = 0;
  await withApi({ storage: { exists: async value => { assert.equal(value, id); probes++; return true; }, read: async () => png } }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as Task).status, 'qr_ready');
    assert.equal(probes, 1);
  });
});

test('仅有工作进程就绪状态，OSS 没有文件时不能误报就绪', async () => {
  await withApi({ tasks: tasks({ getForUser: async () => ({ ...baseTask, status: 'qr_ready' }) }) }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    assert.equal((await response.json() as Task).status, 'preparing_qr');
  });
});

test('无效 ID 在授权后返回 400，不读取任务或二维码存储', async () => {
  const unexpected = async (): Promise<never> => assert.fail('invalid ids must not touch tasks or storage');
  await withApi({ tasks: tasks({ getForUser: unexpected }), storage: { exists: unexpected, read: unexpected } }, async base => {
    assert.equal((await fetch(`${base}/api/login-sessions/invalid`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/login-sessions/invalid/qr`, { headers })).status, 400);
  });
});

test('过期会话停止存储访问，图片接口返回 410', async () => {
  const unexpected = async (): Promise<never> => assert.fail('expired sessions must not touch storage');
  await withApi({ now: () => start + 120000, storage: { exists: unexpected, read: unexpected } }, async base => {
    assert.equal((await (await fetch(`${base}/api/login-sessions/${id}`, { headers })).json() as Task).status, 'expired');
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 410);
  });
});

test('读取过程中过期的图片也不能送给客户端', async () => {
  let current = start;
  await withApi({ now: () => current, storage: { exists: async () => true, read: async () => { current += 120000; return png; } } }, async base => {
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 410);
  });
});

test('图片返回 PNG 且禁用缓存，缺失图片为 404', async () => {
  await withApi({}, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}/qr`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /image\/png/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  });
  await withApi({ storage: { exists: async () => false, read: async () => null } }, async base => {
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 404);
  });
});

test('失败会话不读取图片，非法图片不会透传客户端', async () => {
  const unexpected = async (): Promise<never> => assert.fail('failed tasks must not touch storage');
  await withApi({ tasks: tasks({ getForUser: async () => ({ ...baseTask, status: 'failed' }) }), storage: { exists: unexpected, read: unexpected } }, async base => {
    assert.equal((await (await fetch(`${base}/api/login-sessions/${id}`, { headers })).json() as Task).status, 'failed');
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 409);
  });
  await withApi({ storage: { exists: async () => true, read: async () => Buffer.from('secret invalid file') } }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}/qr`, { headers });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret invalid file/);
  });
});

test('非法 JSON 使用统一 JSON 错误响应', async () => {
  await withApi({}, async base => {
    const response = await fetch(`${base}/api/login-sessions`, { ...post, body: '{' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: '请求格式无效。' });
  });
});

test('OSS 必需配置、TTL、数据库和 Redis 配置在启动时校验', () => {
  assert.throws(() => loadConfig({ STORAGE_DRIVER: 'oops' }), /STORAGE_DRIVER/);
  assert.throws(() => loadConfig({ STORAGE_DRIVER: 'oss' }), /OSS_REGION/);
  assert.throws(() => loadConfig({ SESSION_TTL_MS: 'NaN' }), /SESSION_TTL_MS/);
  assert.throws(() => loadConfig({ REDIS_URL: 'https://example.com' }), /REDIS_URL/);
  assert.throws(() => loadConfig({ REDIS_URL: 'not-a-url' }), /REDIS_URL/);
  assert.throws(() => loadConfig({ REDIS_QUEUE_KEY: 'invalid key' }), /REDIS_QUEUE_KEY/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'https://example.com/database' }), /DATABASE_URL/);
  assert.equal(loadConfig({ REDIS_URL: 'rediss://user:password@redis.example:6379/0' }).redisQueueKey, 'naruto:login:tasks');
  assert.equal(loadConfig({}).redisUrl, undefined);
  assert.throws(() => loadConfig({ OSS_KEY_PREFIX: '../escape' }), /OSS_KEY_PREFIX/);
});

test('无数据库且无 Cookie 时 health/me 可用，二维码申请先返回 401', async () => {
  await withApi({ auth: new AuthService(config), tasks: new TaskService(config) }, async base => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const me = await fetch(`${base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { user: null });
    const response = await fetch(`${base}/api/login-sessions`, { ...post, headers: jsonHeaders });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
  });
});

test('已认证但未配置 Redis 时申请明确返回 503', async () => {
  await withApi({ tasks: new TaskService(config) }, async base => {
    const response = await fetch(`${base}/api/login-sessions`, post);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Redis 未配置，请先配置 REDIS_URL。', code: 'REDIS_NOT_CONFIGURED' });
  });
});
