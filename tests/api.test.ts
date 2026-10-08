import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { AuthService, type AuthSession, type User } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import type { Task } from '../src/server/queue.js';
import type { AuthStore } from '../src/server/database.js';
import { loginFailure } from '../src/shared/task-errors.js';

const config = loadConfig({});
const id = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '123e4567-e89b-42d3-a456-426614174111';
const token = 'eyJhbGciOiJIUzI1NiJ9.user-fixture.signature';
const otherToken = 'eyJhbGciOiJIUzI1NiJ9.other-fixture.signature';
const user: User = { id: '456e7890-e89b-42d3-a456-426614174000', username: 'naruto', isAdmin: false };
const otherUser: User = { id: '456e7890-e89b-42d3-a456-426614174001', username: 'sasuke', isAdmin: false };
const admin: User = { id: '456e7890-e89b-42d3-a456-426614174002', username: 'admin-fixture', isAdmin: true };
const adminToken = 'eyJhbGciOiJIUzI1NiJ9.admin-fixture.signature';
const adminHeaders = { Cookie: `naruto_session=${adminToken}` };
const start = Date.now();
const baseTask: Task = { id, status: 'opening_game', createdAt: new Date(start).toISOString(),
  expiresAt: new Date(start + 120000).toISOString(), simulation: true };
const authSession: AuthSession = { user, token, expiresAt: new Date(start + 604800000) };
const application = { id, userId: user.id, username: user.username, status: 'pending' as const,
  createdAt: new Date(start).toISOString(), reviewedAt: null, reviewedBy: null, reason: null };
const registration = { application, message: '注册申请已提交，请等待管理员审核。' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const headers = { Cookie: `naruto_session=${token}` };
const otherHeaders = { Cookie: `naruto_session=${otherToken}` };
const jsonHeaders = { 'Content-Type': 'application/json' };
const post = { method: 'POST', headers: { ...headers, ...jsonHeaders }, body: '{}' };

function events(overrides: Partial<Dependencies['events']> = {}): Dependencies['events'] {
  return { create: async () => ({ ...baseTask, status: 'queued' }), getForUser: async () => ({ ...baseTask }),
    getActive: async () => null, recordStatus: async () => {}, ...overrides };
}
function auth(overrides: Partial<Dependencies['auth']> = {}): Dependencies['auth'] {
  return { register: async () => registration, login: async () => authSession,
    listApplications: async () => ({ applications: [application] }), reviewApplication: async () => ({ application }),
    getUser: async value => value === token ? user : value === otherToken ? otherUser : value === adminToken ? admin : null, ...overrides };
}
async function withApi(deps: Partial<Dependencies>, run: (base: string) => Promise<void>, trustProxy = false) {
  const app = createApp(config, { events: events(), auth: auth(),
    storage: { exists: async () => false, read: async () => png }, now: () => start, ...deps });
  if (trustProxy) app.set('trust proxy', 1);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('user management and daily task APIs enforce admin identity, JSON and same-origin before invoking services', async () => {
  const calls: unknown[][] = [];
  const managed = { ...user, isInvalid: false, createdAt: new Date(start).toISOString(), applicationStatus: null };
  const adminService: NonNullable<Dependencies['admin']> = {
    listUsers: async (actor, query) => { calls.push(['list', actor.id, query]); return { items: [managed], total: 1, page: 1, pageSize: 20 }; },
    getUser: async (actor, target) => { calls.push(['get', actor.id, target]); return { user: managed }; },
    createUser: async (actor, body) => { calls.push(['create', actor.id, body]); return { user: managed }; },
    updateUser: async (actor, target, body) => { calls.push(['update', actor.id, target, body]); return { user: managed }; },
    deleteUser: async (actor, target) => { calls.push(['delete', actor.id, target]); },
    dailyTasks: async (actor, query) => { calls.push(['daily', actor.id, query]); return { items: [], total: 0, page: 1, pageSize: 20, date: '2026-10-08', timeZone: 'Asia/Shanghai' }; },
  };
  await withApi({ admin: adminService }, async base => {
    const routes = [{ path: '/api/admin/users', method: 'GET' }, { path: `/api/admin/users/${user.id}`, method: 'GET' },
      { path: '/api/admin/daily-tasks', method: 'GET' }, { path: '/api/admin/users', method: 'POST' },
      { path: `/api/admin/users/${user.id}`, method: 'PATCH' }, { path: `/api/admin/users/${user.id}`, method: 'DELETE' }];
    for (const route of routes) for (const attempt of [{ headers: {}, status: 401 }, { headers, status: 403 }]) {
      const response = await fetch(`${base}${route.path}`, { method: route.method, headers: { ...jsonHeaders, ...attempt.headers },
        ...(route.method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(response.status, attempt.status); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(calls, []);
    const mutation = { username: 'new-user', password: 'password', isAdmin: false, isInvalid: false, adminId: 'forged' };
    for (const route of routes) {
      const options = { method: route.method, headers: { ...adminHeaders, ...jsonHeaders }, ...(route.method === 'GET' ? {} : { body: JSON.stringify(mutation) }) };
      if (route.method !== 'GET') {
        assert.equal((await fetch(`${base}${route.path}`, { ...options, headers: { ...options.headers, Origin: 'https://hostile.example' } })).status, 403);
        assert.equal((await fetch(`${base}${route.path}`, { ...options, headers: { ...adminHeaders, 'Content-Type': 'text/plain' } })).status, 415);
      }
      const response = await fetch(`${base}${route.path}`, options);
      assert.equal(response.status, route.method === 'POST' ? 201 : route.method === 'DELETE' ? 204 : 200);
    }
    assert.equal(calls.length, 6);
    assert.ok(calls.every(call => call[1] === admin.id));
    assert.deepEqual(calls[3], ['create', admin.id, mutation]);
    assert.deepEqual(calls[4], ['update', admin.id, user.id, mutation]);
    assert.deepEqual(calls[5], ['delete', admin.id, user.id]);
  });
  await withApi({ admin: adminService, auth: auth({ getUser: async () => ({ ...admin, isAdmin: false }) }) }, async base => {
    assert.equal((await fetch(`${base}/api/admin/users`, { headers: adminHeaders })).status, 403);
    assert.equal(calls.length, 6);
  });
});

test('事件身份来自 Cookie，请求编号透传服务且不作为事件编号，不返回内部凭证', async () => {
  const submitted: { userId: string; requestId: string }[] = [];
  await withApi({ events: events({ create: async (userId, inputRequestId) => {
    submitted.push({ userId, requestId: inputRequestId });
    return { ...baseTask, status: 'queued' };
  } }) }, async base => {
    for (const account of [{ headers, owner: user }, { headers: otherHeaders, owner: otherUser }]) {
      const response = await fetch(`${base}/api/login-sessions`, { ...post, headers: { ...account.headers, ...jsonHeaders },
        body: JSON.stringify({ userId: 'forged-user', id: requestId, accessToken: 'forged-token', requestId }) });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as Task & Record<string, unknown>;
      assert.equal(Object.hasOwn(body, 'accessToken'), false);
      assert.equal(Object.hasOwn(body, 'tokenHash'), false);
      assert.equal(Object.hasOwn(body, 'userId'), false);
      assert.equal(body.id, id);
      assert.notEqual(body.id, requestId);
      assert.equal(body.status, 'queued');
      assert.equal(body.showGetButton, false);
      assert.equal(body.simulation, true);
      assert.equal(Date.parse(body.expiresAt) - Date.parse(body.createdAt), 120000);
    }
    assert.deepEqual(submitted, [{ userId: user.id, requestId }, { userId: otherUser.id, requestId }]);
  });
});

test('缺省 requestId 生成独立 UUIDv4，提供的 requestId 必须合法', async () => {
  const received: string[] = [];
  await withApi({ events: events({ create: async (userId, value) => {
    assert.equal(userId, user.id);
    received.push(value);
    return baseTask;
  } }) }, async base => {
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await fetch(`${base}/api/login-sessions`, post)).status, 202);
    assert.equal(received.length, 2);
    assert.notEqual(received[0], received[1]);
    for (const value of received) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const value of ['not-a-uuid', '', 123, null, '123e4567-e89b-12d3-a456-426614174111']) {
      const response = await fetch(`${base}/api/login-sessions`, { ...post, body: JSON.stringify({ requestId: value }) });
      assert.equal(response.status, 400, `requestId=${JSON.stringify(value)}`);
    }
    assert.equal(received.length, 2, 'invalid request IDs must not create or reuse events');
  });
});

test('创建或复用事件由返回状态决定按钮：处理中及二维码就绪隐藏，失败和过期显示', async () => {
  for (const status of ['queued', 'opening_game', 'qr_ready', 'failed', 'expired'] as const) {
    await withApi({ events: events({ create: async () => ({ ...baseTask, status }) }) }, async base => {
      const response = await fetch(`${base}/api/login-sessions`, { ...post, body: JSON.stringify({ requestId }) });
      assert.equal(response.status, 202);
      const body = await response.json() as Task & { showGetButton: boolean };
      assert.equal(body.id, id);
      assert.equal(body.status, status);
      assert.equal(body.showGetButton, status === 'failed' || status === 'expired');
    });
  }
});

test('队列失败不泄露内部错误，账号冲突透传 409', async () => {
  await withApi({ events: events({ create: async () => { throw new Error('secret sdk path'); } }) }, async base => {
    const response = await fetch(`${base}/api/login-sessions`, post);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret sdk path/);
  });
  await withApi({ events: events({ create: async () => { throw new ApiError(409, '已有登录申请', 'ACTIVE_LOGIN_SESSION'); } }) }, async base => {
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
  await withApi({ auth: auth({ register: unexpected, login: unexpected }), events: events({ create: unexpected }) }, async base => {
    for (const path of ['/api/login-sessions', '/api/auth/register', '/api/auth/login', '/api/auth/logout']) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
        assert.equal((await fetch(`${base}${path}`, { ...post, headers: { ...headers, 'Content-Type': type } })).status, 415, path);
      }
      assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers })).status, 415, path);
    }
  });
});

test('注册只提交待审批申请，不设置登录Cookie；获准登录后才设置HttpOnly/Lax Cookie', async () => {
  const input = { username: user.username, password: 'correct-password' };
  const seen: unknown[] = [];
  await withApi({ auth: auth({ register: async body => { seen.push(body); return registration; },
    login: async body => { seen.push(body); return authSession; } }) }, async base => {
      const registered = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) });
      assert.equal(registered.status, 201);
      assert.equal(registered.headers.get('set-cookie'), null);
      assert.deepEqual(await registered.json(), registration);
      const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { user });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie') ?? '';
      assert.ok(cookie.startsWith(`naruto_session=${token};`));
      assert.match(cookie, /; HttpOnly(?:;|$)/);
      assert.match(cookie, /; SameSite=Lax(?:;|$)/);
      assert.match(cookie, /; Path=\/(?:;|$)/);
      assert.doesNotMatch(cookie, /; Secure(?:;|$)/);
    assert.deepEqual(seen, [input, input]);
  });
});

test('管理员申请列表和审核接口均拒绝匿名与普通账号，不调用审核服务', async () => {
  const forbidden = async (): Promise<never> => assert.fail('must not enter administrator service');
  await withApi({ auth: auth({ listApplications: forbidden, reviewApplication: forbidden }) }, async base => {
    for (const [cookie, expected] of [['', 401], [token, 403], [otherToken, 403]] as const) {
      const list = await fetch(`${base}/api/admin/registration-applications`, { headers: { Cookie: `naruto_session=${cookie}` } });
      assert.equal(list.status, expected);
      const review = await fetch(`${base}/api/admin/registration-applications/${id}/review`, {
        ...post, headers: { ...jsonHeaders, Cookie: `naruto_session=${cookie}` },
        body: JSON.stringify({ decision: 'approved', isAdmin: true }),
      });
      assert.equal(review.status, expected);
    }
  });
});

test('管理员筛选与审核操作使用真实Cookie身份，跨站审核和权限撤销都立即拒绝', async () => {
  let enabled = true;
  const reviewed = { ...application, status: 'approved' as const, reviewedAt: new Date(start).toISOString(), reviewedBy: admin.id };
  await withApi({ auth: auth({
    getUser: async value => value === adminToken ? { ...admin, isAdmin: enabled } : null,
    listApplications: async (actor, status) => { assert.deepEqual(actor, admin); assert.equal(status, 'pending'); return { applications: [application] }; },
    reviewApplication: async (actor, applicationId, input) => {
      assert.deepEqual(actor, admin); assert.equal(applicationId, id);
      assert.deepEqual(input, { decision: 'approved', reviewedBy: user.id });
      return { application: reviewed };
    },
  }) }, async base => {
    const list = await fetch(`${base}/api/admin/registration-applications?status=pending`, { headers: adminHeaders });
    assert.equal(list.status, 200); assert.deepEqual(await list.json(), { applications: [application] });
    const options = { ...post, headers: { ...jsonHeaders, ...adminHeaders }, body: JSON.stringify({ decision: 'approved', reviewedBy: user.id }) };
    const response = await fetch(`${base}/api/admin/registration-applications/${id}/review`, options);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { application: reviewed });
    assert.equal((await fetch(`${base}/api/admin/registration-applications/${id}/review`, {
      ...options, headers: { ...options.headers, Origin: 'https://unrelated.example' },
    })).status, 403);
    enabled = false;
    assert.equal((await fetch(`${base}/api/admin/registration-applications`, { headers: adminHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/registration-applications/${id}/review`, options)).status, 403);
  });
});

test('待审核和被拒绝的登录返回受控403，不发放Cookie', async () => {
  for (const code of ['REGISTRATION_PENDING', 'REGISTRATION_REJECTED']) {
    await withApi({ auth: auth({ login: async () => { throw new ApiError(403, '注册申请尚未通过审核。', code); } }) }, async base => {
      const response = await fetch(`${base}/api/auth/login`, { ...post, body: JSON.stringify({ username: user.username, password: 'fixture-password' }) });
      assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null);
      assert.equal((await response.json() as { code: string }).code, code);
    });
  }
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

test('退出仅清除浏览器JWT Cookie，清除后未登录；不会建立服务端撤销状态', async () => {
  await withApi({}, async base => {
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`, { headers })).json(), { user });
    const response = await fetch(`${base}/api/auth/logout`, post);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^naruto_session=;/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/);
    assert.match(cookie, /; Path=\/(?:;|$)/);
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`)).json(), { user: null });
    const denied = await fetch(`${base}/api/login-sessions`, { ...post, headers: jsonHeaders });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as { code: string }).code, 'AUTH_REQUIRED');
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`, { headers })).json(), { user });
  });
});

test('数据库或JWT配置不可用时仍能退出，并按HTTPS清除相同属性的Cookie', async () => {
  const unavailable = async (): Promise<never> => assert.fail('logout must not read authentication or database state');
  await withApi({ auth: auth({ getUser: unavailable }) }, async base => {
    for (const cookie of ['', token, 'legacy-token']) {
      const response = await fetch(`${base}/api/auth/logout`, { ...post, headers: {
        ...jsonHeaders, Cookie: `naruto_session=${cookie}`, 'X-Forwarded-Proto': 'https', Origin: base.replace('http:', 'https:'),
      } });
      assert.equal(response.status, 204);
      assert.match(response.headers.get('set-cookie') ?? '', /; Secure(?:;|$)/);
    }
  }, true);
});

test('真实JWT经Cookie恢复身份，重启服务仍有效，篡改/过期/停用被拒绝', async () => {
  const secret = 'api-test-only-jwt-signing-secret-at-least-32-bytes';
  const jwtConfig = loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture', JWT_SECRET: secret });
  let now = start;
  let enabled = true;
  let activeReads = 0;
  const unexpected = async (): Promise<never> => assert.fail('login must not create persisted session state');
  const store: AuthStore = {
    initialize: async () => {},
    findUser: async () => ({ ...user, usernameKey: user.username, password: 'api-fixture-password', isInvalid: false }),
    findActiveUser: async value => { activeReads++; assert.equal(value, user.id); return enabled ? user : null; },
    createRegistration: unexpected, listRegistrationApplications: unexpected, reviewRegistration: unexpected,
    close: async () => {},
  };
  const service = new AuthService(jwtConfig, { store, now: () => now });
  let cookie = '';
  await withApi({ auth: service }, async base => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ username: user.username, password: 'api-fixture-password' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user });
    cookie = response.headers.get('set-cookie')!.split(';')[0];
    assert.match(cookie, /^naruto_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.deepEqual(await me.json(), { user });
  });
  const restarted = new AuthService(jwtConfig, { store, now: () => now });
  await withApi({ auth: restarted }, async base => {
    const headers = { Cookie: cookie };
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`, { headers })).json(), { user });
    const before = activeReads;
    const [header, payload, signature] = cookie.split('=')[1].split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: otherUser.id })).toString('base64url');
    const forged = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `naruto_session=${header}.${forgedPayload}.${signature}` } });
    assert.deepEqual(await forged.json(), { user: null });
    assert.equal(activeReads, before, 'invalid signature must not reach the database');
    enabled = false;
    assert.equal((await fetch(`${base}/api/login-sessions/active`, { headers })).status, 401);
    enabled = true;
    now = start + 7 * 24 * 60 * 60 * 1000;
    assert.deepEqual(await (await fetch(`${base}/api/auth/me`, { headers })).json(), { user: null });
    assert.equal((await fetch(`${base}/api/login-sessions/active`, { headers })).status, 401);
  });
});

test('缺失或无效 Cookie 及仅 Bearer 不能访问二维码接口，且不访问 Redis/OSS', async () => {
  const unexpected = async (): Promise<never> => assert.fail('unauthenticated requests must not touch events or storage');
  const attempts: Record<string, string>[] = [{}, { Authorization: `Bearer ${token}` },
    { Cookie: 'naruto_session=invalid' }, { Cookie: `naruto_session=${'d'.repeat(64)}` },
    { Cookie: 'naruto_session=eyJhbGciOiJIUzI1NiJ9.unknown.signature' },
    { Cookie: `naruto_session=${'a'.repeat(2048)}.b.c` }];
  await withApi({ events: { create: unexpected, getForUser: unexpected, getActive: unexpected, recordStatus: unexpected }, storage: { exists: unexpected, read: unexpected } }, async base => {
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
  const ownedEvents = events({ getForUser: async (requestedId, userId) => {
    assert.equal(requestedId, id);
    if (userId !== user.id) throw new ApiError(404, 'not found');
    return baseTask;
  }, getActive: async userId => userId === user.id ? baseTask : null });
  await withApi({ events: ownedEvents, storage: { exists: async () => assert.fail('must not probe'), read: async () => assert.fail('must not read') } }, async base => {
    for (const suffix of ['', '/qr']) assert.equal((await fetch(`${base}/api/login-sessions/${id}${suffix}`, { headers: otherHeaders })).status, 404);
    const active = await fetch(`${base}/api/login-sessions/active`, { headers: otherHeaders });
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { session: null, showGetButton: true });
  });
  await withApi({ events: ownedEvents }, async base => {
    const active = await fetch(`${base}/api/login-sessions/active`, { headers });
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { session: baseTask, showGetButton: false });
  });
});

test('授权通过后直接检查对象存储，文件已到达即返回就绪', async () => {
  let probes = 0;
  const statuses: unknown[][] = [];
  await withApi({ events: events({ recordStatus: async (...args) => { statuses.push(args); } }),
    storage: { exists: async value => { assert.equal(value, id); probes++; return true; }, read: async () => png } }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as Task & { showGetButton: boolean };
    assert.equal(body.status, 'qr_ready');
    assert.equal(body.showGetButton, false);
    assert.equal(probes, 1);
    assert.deepEqual(statuses, [[id, user.id, 'qr_ready']]);
  });
});

test('仅有工作进程就绪状态，OSS 没有文件时不能误报就绪', async () => {
  await withApi({ events: events({ getForUser: async () => ({ ...baseTask, status: 'qr_ready' }) }) }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    const body = await response.json() as Task & { showGetButton: boolean };
    assert.equal(body.status, 'preparing_qr');
    assert.equal(body.showGetButton, false);
  });
});

test('无效 ID 在授权后返回 400，不读取任务或二维码存储', async () => {
  const unexpected = async (): Promise<never> => assert.fail('invalid ids must not touch events or storage');
  await withApi({ events: events({ getForUser: unexpected }), storage: { exists: unexpected, read: unexpected } }, async base => {
    assert.equal((await fetch(`${base}/api/login-sessions/invalid`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/login-sessions/invalid/qr`, { headers })).status, 400);
  });
});

test('过期会话停止存储访问，图片接口返回 410', async () => {
  const unexpected = async (): Promise<never> => assert.fail('expired sessions must not touch storage');
  await withApi({ now: () => start + 120000, storage: { exists: unexpected, read: unexpected } }, async base => {
    const body = await (await fetch(`${base}/api/login-sessions/${id}`, { headers })).json() as Task & { showGetButton: boolean };
    assert.equal(body.status, 'expired');
    assert.equal(body.showGetButton, true);
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
  const unexpected = async (): Promise<never> => assert.fail('failed events must not touch storage');
  await withApi({ events: events({ getForUser: async () => ({ ...baseTask, status: 'failed' }) }), storage: { exists: unexpected, read: unexpected } }, async base => {
    const body = await (await fetch(`${base}/api/login-sessions/${id}`, { headers })).json() as Task & { showGetButton: boolean };
    assert.equal(body.status, 'failed');
    assert.equal(body.showGetButton, true);
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
  assert.throws(() => loadConfig({ JWT_SECRET: 'short-key-do-not-echo' }), error => {
    assert(error instanceof Error); assert.match(error.message, /JWT_SECRET/); assert.doesNotMatch(error.message, /short-key-do-not-echo/); return true;
  });
  assert.equal(loadConfig({ JWT_SECRET: 'a'.repeat(32) }).jwtSecret, 'a'.repeat(32));
  assert.equal(loadConfig({}).jwtSecret, undefined);
  assert.equal(loadConfig({ REDIS_URL: 'rediss://user:password@redis.example:6379/0' }).redisQueueKey, 'naruto:login:tasks');
  assert.equal(loadConfig({}).redisUrl, undefined);
  assert.throws(() => loadConfig({ OSS_KEY_PREFIX: '../escape' }), /OSS_KEY_PREFIX/);
});

test('无数据库且无 Cookie 时 health/me 可用，二维码申请先返回 401', async () => {
  const unexpected = async (): Promise<never> => assert.fail('unauthenticated request must not call event persistence');
  await withApi({ auth: new AuthService(config), events: events({ create: unexpected }) }, async base => {
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
  await withApi({ events: events({ create: async () => { throw new ApiError(503, 'Redis 未配置，请先配置 REDIS_URL。', 'REDIS_NOT_CONFIGURED'); } }) }, async base => {
    const response = await fetch(`${base}/api/login-sessions`, post);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Redis 未配置，请先配置 REDIS_URL。', code: 'REDIS_NOT_CONFIGURED' });
  });
});

test('任务日志接口使用 Cookie 身份，独立于二维码过期且不调用登录申请恢复或 OSS', async () => {
  const unexpected = async (): Promise<never> => assert.fail('run logs must not touch login dispatch or QR storage');
  const calls: unknown[][] = [];
  const task = { id, status: 'expired' as const, createdAt: baseTask.createdAt, expiresAt: baseTask.createdAt,
    userOptions: { equipmentStamina: false } };
  const result = { task, run: null, logs: [], nextCursor: '123-4', hasMore: false, truncated: false };
  await withApi({ events: events({ create: unexpected, getForUser: unexpected, getActive: unexpected, recordStatus: unexpected }),
    storage: { exists: unexpected, read: unexpected }, runs: {
      async getLatest(userId) { calls.push(['latest', userId]); return { task }; },
      async getEvents(taskId, userId, after) { calls.push(['events', taskId, userId, after]); return result; },
    } }, async base => {
    for (const route of ['/api/task-runs/latest', `/api/task-runs/${id}/events`]) {
      const unauthenticated = await fetch(`${base}${route}`);
      assert.equal(unauthenticated.status, 401);
      assert.equal((await unauthenticated.json() as { code: string }).code, 'AUTH_REQUIRED');
    }
    const latest = await fetch(`${base}/api/task-runs/latest`, { headers });
    assert.equal(latest.status, 200);
    assert.deepEqual(await latest.json(), { task });
    const response = await fetch(`${base}/api/task-runs/${id}/events?after=123-4&userId=forged`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), result);
    await fetch(`${base}/api/task-runs/${id}/events`, { headers: otherHeaders });
    assert.deepEqual(calls, [['latest', user.id], ['events', id, user.id, '123-4'], ['events', id, otherUser.id, '0-0']]);
  });
});

test('日志游标拒绝重复参数和非法范围，服务错误仅返回脱敏响应且旧接口仍可用', async () => {
  const unexpected = async (): Promise<never> => assert.fail('invalid cursor must not reach the service');
  await withApi({ runs: { getLatest: unexpected, getEvents: unexpected } }, async base => {
    for (const query of ['after=-', 'after=1-0&after=2-0', 'after=1-01', 'after=18446744073709551616-0', 'after=0-0%0A']) {
      assert.equal((await fetch(`${base}/api/task-runs/${id}/events?${query}`, { headers })).status, 400);
    }
    assert.equal((await fetch(`${base}/api/task-runs/not-a-uuid/events`, { headers })).status, 400);
  });
  await withApi({ runs: { getLatest: async () => { throw new Error('secret redis URL'); }, getEvents: unexpected } }, async base => {
    const response = await fetch(`${base}/api/task-runs/latest`, { headers });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret|redis URL/);
    assert.equal((await fetch(`${base}/api/login-sessions/active`, { headers })).status, 200);
  });
});

test('用户选项通过统一 JSON 传入服务，兼容旧请求且严格区分布尔开关', async () => {
  const received: unknown[] = [];
  await withApi({ events: events({ create: async (_userId, _requestId, userOptions) => {
    received.push(userOptions);
    return { ...baseTask, userOptions };
  } }) }, async base => {
    for (const body of [{}, { userOptions: {} }, { userOptions: { equipmentStamina: true } },
      { userOptions: { equipmentStamina: false } }]) {
      const response = await fetch(`${base}/api/login-sessions`, { ...post, body: JSON.stringify({ requestId, ...body }) });
      assert.equal(response.status, 202);
      assert.deepEqual((await response.json() as Task).userOptions, received.at(-1));
    }
    assert.deepEqual(received, [{ equipmentStamina: true }, { equipmentStamina: true },
      { equipmentStamina: true }, { equipmentStamina: false }]);
    for (const userOptions of [null, [], 'false', true, { equipmentStamina: 'false' },
      { equipmentStamina: 0 }, { equipmentStamina: null }, { equipmentStamina: false, workerId: 'forged' }]) {
      const response = await fetch(`${base}/api/login-sessions`, { ...post, body: JSON.stringify({ requestId, userOptions }) });
      assert.equal(response.status, 400, JSON.stringify(userOptions));
      assert.equal((await response.json() as { code: string }).code, 'INVALID_USER_OPTIONS');
    }
    assert.equal(received.length, 4, 'invalid options must not reserve or dispatch a task');
  });
});

test('已失败申请的明确安全原因不被原二维码到期覆盖，不查询 OSS', async () => {
  const unexpected = async (): Promise<never> => assert.fail('failed request must not query QR storage');
  const failed = { ...baseTask, status: 'failed' as const, expiresAt: new Date(start - 1).toISOString(), ...loginFailure('worker_clock_skew') };
  await withApi({ events: events({ getForUser: async () => failed }), storage: { exists: unexpected, read: unexpected } }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...failed, showGetButton: true });
  });
});
