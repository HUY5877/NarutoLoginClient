import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { McpQqBindingService, PgMcpQqBindingStore, type McpQqBindingPool } from '../src/server/mcp-qq-bindings.js';
import { PgQqRobotBindingStore } from '../src/server/qq-robot-bindings.js';

const userId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '10000000-0000-4000-8000-000000000002';
const taskId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const secret = 'fixture-backend-only-key-1234567890123456';
const token = 'A'.repeat(43);
const bindingCode = 'aB_12-CD34ef56Gh78ij90Kl';
const config = loadConfig({ HYRZ_MCP_TOKEN: secret, HYRZ_PUBLIC_URL: 'https://site.example' });
const task = { id: taskId, status: 'queued', simulation: true, createdAt: '2026-11-06T00:00:00.000Z',
  expiresAt: '2099-11-06T00:05:00.000Z', loginType: 'ios_wechat',
  userOptions: { mainTask: 'daily', equipmentStamina: false, secretRealmMode: 'skip' } };

function dependencies() {
  return {
    auth: { getUser: async (value: string) => value === 'fixture.cookie.signature' ? { id: userId, username: '测试账号', isAdmin: false } : null },
    events: { create: async () => task, getForUser: async () => task, recordStatus: async () => {} },
    storage: { exists: async () => false, read: async () => null },
    mcpBindings: {
      bind: async (qq: string) => ({ qq, userId }),
      getStatus: async () => ({ enabled: true, binding: null, challenge: null }),
      createChallenge: async () => ({ id: taskId, code: bindingCode, expiresAt: '2099-11-06T00:05:00.000Z' }),
      create: async (qq: string) => ({ qq, bindingUrl: `https://site.example/#mcp-bind=${token}`, expiresAt: '2099-11-06T00:05:00.000Z' }),
      preview: async () => ({ qq: '123456789', expiresAt: '2099-11-06T00:05:00.000Z' }),
      confirm: async (id: string) => ({ qq: '123456789', userId: id, boundAt: '2026-11-06T00:00:00.000Z' }),
      resolve: async (qq: string) => ({ qq, userId }),
      unbind: async (id: string) => ({ userId: id, status: 'unbound' }),
      resolveRobot: async (qq: string) => ({ qq, userId }),
      unbindRobot: async (id: string) => ({ userId: id, status: 'unbound' }),
      assertActiveUser: async () => {},
    },
  } as unknown as Dependencies;
}

async function fixture(t: TestContext, deps = dependencies(), appConfig = config, trustProxy = false) {
  const app = createApp(appConfig, deps);
  if (trustProxy) app.set('trust proxy', 1);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.locals.closeHyrzMcp?.();
  });
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('后台直接绑定不需要网站Cookie、网站地址或确认链接', async t => {
  const deps = dependencies();
  const received: string[] = [];
  deps.mcpBindings!.bind = async qq => { received.push(qq); return { qq, userId }; };
  deps.mcpBindings!.create = async () => { throw new Error('不能创建待确认链接'); };
  deps.auth.getUser = async () => { throw new Error('MCP绑定不能要求网站登录'); };
  const base = await fixture(t, deps, loadConfig({ HYRZ_MCP_TOKEN: secret }));
  const results = await Promise.all(Array.from({ length: 3 }, () => call(base, 'bind_qq', { qq: '123456789' })));
  assert.deepEqual(received, ['123456789', '123456789', '123456789']);
  assert.deepEqual(results, Array.from({ length: 3 }, () => ({ qq: '123456789', userId })));
});

test('直接绑定在新旧MCP协议和反代连接下返回同一用户而非链接', async t => {
  const deps = dependencies();
  const base = await fixture(t, deps, loadConfig({ HYRZ_MCP_TOKEN: secret }), true);
  for (const version of ['2026-07-28', '2025-11-25']) {
    const results = await Promise.all(['https', 'http'].map(protocol =>
      call(base, 'bind_qq', { qq: '123456789' }, { 'X-Forwarded-Proto': protocol,
        'X-Forwarded-Host': 'untrusted.example', 'MCP-Protocol-Version': version })));
    assert.deepEqual(results, [{ qq: '123456789', userId }, { qq: '123456789', userId }]);
  }
});

async function payload(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
    return data.find(value => value.result || value.error) ?? {};
  }
  return text ? JSON.parse(text) : {};
}

async function rpc(base: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const version = headers['MCP-Protocol-Version'] ?? '2026-07-28';
  const envelope = version === '2026-07-28' ? { _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'fixture', version: '1.0.0' },
  } } : {};
  return fetch(`${base}/api/mcp`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    Authorization: `Bearer ${secret}`, 'MCP-Protocol-Version': '2026-07-28', ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...envelope } }) });
}

async function call(base: string, name: string, args: unknown, headers: Record<string, string> = {}) {
  const response = await rpc(base, 'tools/call', { name, arguments: args }, headers);
  const body = await payload(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert(body.result, JSON.stringify(body));
  const output = body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
  // Mastra advertises legacy union outputs as object-shaped {result: ...} schemas.
  return output.result ?? output;
}

test('hyrz 未配置时关闭，网站健康接口仍可用', async t => {
  const base = await fixture(t, dependencies(), loadConfig({}));
  assert.equal((await rpc(base, 'tools/list')).status, 503);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('hyrz 拒绝缺失或错误后台密钥，网站Cookie不能替代后台认证', async t => {
  const base = await fixture(t);
  for (const Authorization of ['', 'Bearer wrong', 'Basic wrong']) {
    const response = await rpc(base, 'tools/list', {}, { Authorization, Cookie: 'naruto_session=fixture.cookie.signature' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
    assert.equal((await response.text()).includes(secret), false);
  }
});

test('客户端请求头中的短Token必须与服务端配置完全一致', async t => {
  const base = await fixture(t, dependencies(), loadConfig({ HYRZ_MCP_TOKEN: 'demo' }));
  for (const [value, expectedStatus] of [['demo', 200], ['Demo', 401], ['demo1', 401], ['dem', 401]]) {
    assert.equal((await rpc(base, 'tools/list', {}, { Authorization: `Bearer ${value}` })).status, expectedStatus);
  }
});

test('hyrz 拒绝非允许来源且通过真实Mastra列出全部五个工具', async t => {
  const base = await fixture(t);
  assert.equal((await rpc(base, 'tools/list', {}, { Origin: 'https://untrusted.example' })).status, 403);
  const response = await rpc(base, 'tools/list');
  const body = await payload(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ['bind_qq', 'get_qrcode_status', 'qq_to_userid', 'request_qrcode', 'unbind_qq']);
  const bindingTool = body.result.tools.find((tool: { name: string }) => tool.name === 'bind_qq');
  assert(JSON.stringify(bindingTool.outputSchema).includes('userId'));
  assert(!JSON.stringify(bindingTool.outputSchema).includes('bindingUrl'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('hyrz 为现有MCP客户端保留无会话初始化和工具调用', async t => {
  const base = await fixture(t);
  const response = await rpc(base, 'initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'fixture', version: '1.0.0' } }, { 'MCP-Protocol-Version': '2025-11-25' });
  const body = await payload(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.result.serverInfo.name, 'hyrz');
  const resolved = await call(base, 'qq_to_userid', { qq: '123456789' }, { 'MCP-Protocol-Version': '2025-11-25' });
  assert.equal(resolved.userId, userId, JSON.stringify(resolved));
});

test('hyrz QQ绑定直接返回用户ID，解析和解绑由专用工具执行', async t => {
  const base = await fixture(t);
  const binding = await call(base, 'bind_qq', { qq: '123456789' });
  assert.deepEqual(binding, { qq: '123456789', userId });
  assert.deepEqual(await call(base, 'qq_to_userid', { qq: '123456789' }), { qq: '123456789', userId });
  assert.deepEqual(await call(base, 'unbind_qq', { userId }), { userId, status: 'unbound' });
});

test('直接绑定拒绝未认证调用及非法QQ，不向绑定服务提交', async t => {
  const deps = dependencies(); let submitted = 0;
  deps.mcpBindings!.bind = async qq => { submitted++; return { qq, userId }; };
  const base = await fixture(t, deps);
  for (const Authorization of ['', 'Bearer wrong']) {
    assert.equal((await rpc(base, 'tools/call', { name: 'bind_qq', arguments: { qq: '123456789' } }, { Authorization })).status, 401);
  }
  for (const args of [{ qq: '0123' }, { qq: '123\n' }, { qq: 123 }, { qq: '123', userId }]) {
    const result = await payload(await rpc(base, 'tools/call', { name: 'bind_qq', arguments: args }));
    assert.equal(result.result.isError, true);
  }
  assert.equal(submitted, 0);
});

test('直接绑定保留停用错误并隐藏未知底层异常', async t => {
  const deps = dependencies();
  let failSafely = true;
  deps.mcpBindings!.bind = async () => {
    if (failSafely) throw new ApiError(403, '网站账号不存在或已停用。', 'MCP_USER_INACTIVE');
    throw new Error('private-database-details');
  };
  const base = await fixture(t, deps);
  const inactive = await call(base, 'bind_qq', { qq: '123456789' });
  assert.equal(inactive.status, 'error'); assert.equal(inactive.code, 'MCP_USER_INACTIVE');
  failSafely = false;
  const unknown = await call(base, 'bind_qq', { qq: '123456789' });
  assert.equal(unknown.status, 'error'); assert.equal(unknown.code, 'HYRZ_TOOL_FAILED');
  assert(!JSON.stringify(unknown).includes('private-database-details'));
});

test('网站绑定码透传给MCP绑定服务，错误绑定码不会回退无代码注册', async t => {
  const deps = dependencies(); const submitted: unknown[][] = [];
  deps.mcpBindings!.bind = async (qq, code?: string) => {
    submitted.push([qq, code]);
    if (code) throw new ApiError(409, '绑定码已失效，请重新生成。', 'MCP_QQ_BINDING_CODE_EXPIRED');
    return { qq, userId };
  };
  const base = await fixture(t, deps);
  const failure = await call(base, 'bind_qq', { qq: '123456789', bindingCode });
  assert.equal(failure.status, 'error'); assert.equal(failure.code, 'MCP_QQ_BINDING_CODE_EXPIRED');
  assert.deepEqual(submitted, [['123456789', bindingCode]]);
  assert(!JSON.stringify(failure).includes(bindingCode));
  assert.deepEqual(await call(base, 'bind_qq', { qq: '123456789' }), { qq: '123456789', userId });
  assert.deepEqual(submitted, [['123456789', bindingCode], ['123456789', undefined]]);
});

test('MCP拒绝格式错误的绑定码且不调用绑定服务', async t => {
  const deps = dependencies(); let submitted = false;
  deps.mcpBindings!.bind = async qq => { submitted = true; return { qq, userId }; };
  const base = await fixture(t, deps);
  for (const code of ['', 'ABCD1234', null, 123, `${bindingCode}\n`]) {
    const response = await payload(await rpc(base, 'tools/call', {
      name: 'bind_qq', arguments: { qq: '123456789', bindingCode: code },
    }));
    assert.equal(response.result.isError, true, `bindingCode: ${JSON.stringify(code)}`);
  }
  assert.equal(submitted, false);
});

test('网站数字QQ发码查询和解绑需要登录且只使用Cookie身份，无需官方机器人配置', async t => {
  const deps = dependencies(); const calls: unknown[][] = [];
  deps.mcpBindings!.getStatus = async id => { calls.push(['status', id]); return { enabled: true, binding: null, challenge: null }; };
  deps.mcpBindings!.createChallenge = async id => {
    calls.push(['challenge', id]); return { id: taskId, code: bindingCode, expiresAt: '2099-11-06T00:05:00.000Z' };
  };
  deps.mcpBindings!.unbindRobot = async id => { calls.push(['unbind', id]); return { userId: id, status: 'unbound' }; };
  const base = await fixture(t, deps);
  const endpoint = `${base}/api/qq-number-binding`;
  const send = (method: string, suffix = '', value: unknown = {}) => fetch(`${endpoint}${suffix}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: 'naruto_session=fixture.cookie.signature' },
    ...(method === 'POST' ? { body: JSON.stringify(value) } : {}),
  });
  for (const [method, suffix] of [['GET', ''], ['POST', '/challenge'], ['DELETE', '']]) {
    assert.equal((await fetch(`${endpoint}${suffix}`, { method, headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}) })).status, 401);
  }
  assert.deepEqual(calls, []);
  assert.equal((await send('GET', `?userId=${otherUserId}`)).status, 200);
  const challenge = await send('POST', '/challenge'); assert.equal(challenge.status, 201);
  assert.deepEqual(await challenge.json(), { id: taskId, code: bindingCode, expiresAt: '2099-11-06T00:05:00.000Z' });
  assert.equal((await send('POST', '/challenge', { userId: otherUserId })).status, 400);
  assert.equal((await send('DELETE', `?userId=${otherUserId}`)).status, 204);
  assert.deepEqual(calls, [['status', userId], ['challenge', userId], ['unbind', userId]]);
});

test('网站数字QQ接口拒绝跨站写入，未配置MCP时不伪装可绑定', async t => {
  const deps = dependencies(); let submitted = false;
  deps.mcpBindings!.createChallenge = async () => { submitted = true; throw new Error('unexpected mutation'); };
  const base = await fixture(t, deps);
  const headers = { 'Content-Type': 'application/json', Cookie: 'naruto_session=fixture.cookie.signature' };
  for (const extra of [{ Origin: 'https://hostile.example' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await fetch(`${base}/api/qq-number-binding/challenge`, {
      method: 'POST', headers: { ...headers, ...extra }, body: '{}',
    })).status, 403);
  }
  assert.equal(submitted, false);
  const disabled = await fixture(t, deps, loadConfig({}));
  const status = await fetch(`${disabled}/api/qq-number-binding`, { headers });
  assert.deepEqual(await status.json(), { enabled: false, binding: null, challenge: null });
  assert.equal((await fetch(`${disabled}/api/qq-number-binding/challenge`, { method: 'POST', headers, body: '{}' })).status, 503);
});

test('hyrz 申请保留幂等ID并报告已有任务的真实参数，不假称新参数生效', async t => {
  const deps = dependencies();
  const submitted: unknown[][] = [];
  deps.events.create = async (...args) => { submitted.push(args); return task as never; };
  const base = await fixture(t, deps);
  const result = await call(base, 'request_qrcode', { userId, requestId, loginType: 'android_wechat',
    userOptions: { equipmentStamina: true, secretRealmMode: 'all' } });
  assert.equal(result.taskId, taskId);
  assert.equal(result.loginType, 'ios_wechat');
  assert.deepEqual(result.userOptions, task.userOptions);
  assert.equal(submitted[0][0], userId);
  assert.equal(submitted[0][1], requestId);
  assert.equal(submitted[0][3], 'android_wechat');
});

test('hyrz 拒绝带换行的申请ID，不向任务服务提交', async t => {
  const deps = dependencies();
  let submitted = false;
  deps.events.create = async () => { submitted = true; return task as never; };
  const base = await fixture(t, deps);
  const body = await payload(await rpc(base, 'tools/call', { name: 'request_qrcode', arguments: {
    userId, requestId: `${requestId}\n`, loginType: 'android_wechat',
  } }));
  assert.equal(body.result.isError, true);
  assert.equal(submitted, false);
});

test('hyrz 用户ID工具每次核对有效账号，拒绝停用后继续调用且错误不泄漏底层内容', async t => {
  const deps = dependencies();
  deps.mcpBindings!.assertActiveUser = async () => { throw new ApiError(403, '账号不可用。', 'ACCOUNT_DISABLED'); };
  const base = await fixture(t, deps);
  const result = await call(base, 'request_qrcode', { userId, requestId, loginType: 'android_qq' });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'ACCOUNT_DISABLED');
  const deps2 = dependencies();
  deps2.mcpBindings!.resolveRobot = async () => { throw new Error('secret=should-never-appear'); };
  const base2 = await fixture(t, deps2);
  const unknown = await call(base2, 'qq_to_userid', { qq: '123456789' });
  assert.equal(unknown.status, 'error');
  assert(!JSON.stringify(unknown).includes('should-never-appear'));
});

test('hyrz 并发查询仍使用各自的用户ID和任务，不能读取他人二维码', async t => {
  const deps = dependencies();
  deps.events.getForUser = async (id, owner) => {
    await new Promise(resolve => setImmediate(resolve));
    if (owner !== userId && owner !== otherUserId || id !== owner) throw new ApiError(404, '申请不存在。');
    return { ...task, id } as never;
  };
  const base = await fixture(t, deps);
  const results = await Promise.all([userId, otherUserId].map(id => call(base, 'get_qrcode_status', { userId: id, taskId: id })));
  assert.deepEqual(results.map(result => [result.taskId, result.status]), [[userId, 'running'], [otherUserId, 'running']]);
  const foreign = await call(base, 'get_qrcode_status', { userId, taskId });
  assert.equal(foreign.status, 'error');
});

test('hyrz 接受大写UUID但以同一规范用户和任务身份查询', async t => {
  const id = 'abcdef00-abcd-4bcd-abcd-abcdef123456';
  const deps = dependencies();
  deps.mcpBindings!.assertActiveUser = async owner => { assert.equal(owner, id); };
  deps.events.getForUser = async (requested, owner) => { assert.equal(requested, id); assert.equal(owner, id); return { ...task, id } as never; };
  const base = await fixture(t, deps);
  assert.equal((await call(base, 'get_qrcode_status', { userId: id.toUpperCase(), taskId: id.toUpperCase() })).status, 'running');
});

test('数字QQ确认必须使用网站登录身份和明确确认，不依赖MCP传userId', async t => {
  const deps = dependencies();
  const confirmed: string[] = [];
  deps.mcpBindings!.confirm = async id => { confirmed.push(id); return { qq: '123456789', userId: id, boundAt: '2026-11-06T00:00:00.000Z' }; };
  const base = await fixture(t, deps);
  const send = (path: string, cookie = '', body: unknown = { token }) => fetch(`${base}/api/mcp-bindings/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  assert.equal((await send('preview')).status, 401);
  assert.equal((await send('confirm')).status, 401);
  const cookie = 'naruto_session=fixture.cookie.signature';
  assert.equal((await send('preview', cookie)).status, 200);
  assert.deepEqual(confirmed, []);
  assert.equal((await send('confirm', cookie, { token, userId: otherUserId })).status, 400);
  assert.equal((await send('confirm', cookie)).status, 400);
  for (const expectedUserId of ['', null, 12, `${userId}\n`, 'not-a-uuid']) {
    assert.equal((await send('confirm', cookie, { token, expectedUserId })).status, 400);
  }
  assert.equal((await send('preview', cookie, { token, expectedUserId: userId })).status, 400);
  assert.equal((await send('confirm', cookie, { token, expectedUserId: userId })).status, 200);
  assert.deepEqual(confirmed, [userId]);
});

test('真实MCP无需网页登录直接建用户并绑定，重复调用复用且可继续解析和申请二维码', async t => {
  const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
  const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users(
    id uuid PRIMARY KEY, username text NOT NULL, username_key text NOT NULL UNIQUE, password text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), is_invalid boolean NOT NULL DEFAULT true,
    is_admin boolean NOT NULL DEFAULT false, admin_note text NOT NULL DEFAULT '');`);
  const pool: McpQqBindingPool = { async connect() { return { async query(sql, values) {
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows };
  }, release() {} }; }, async end() {} };
  const appConfig = loadConfig({ HYRZ_MCP_TOKEN: secret,
    DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture' });
  const store = new PgMcpQqBindingStore(appConfig, { beforeInitialize: async () => {}, pool });
  const robotStore = new PgQqRobotBindingStore(appConfig, { beforeInitialize: async () => {}, pool });
  const bindingService = new McpQqBindingService(appConfig, { beforeInitialize: async () => {}, store, robotStore });
  const deps = dependencies();
  deps.mcpBindings = bindingService;
  deps.storage.read = async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  deps.storage.signUrl = async () => 'https://fixture-bucket.oss-cn-shanghai.aliyuncs.com/login/qr.png?fixture=signed';
  const base = await fixture(t, deps, appConfig);
  t.after(async () => { await bindingService.close(); await db.close(); });
  const bound = await call(base, 'bind_qq', { qq: '123456789' });
  assert.deepEqual(Object.keys(bound).sort(), ['qq', 'userId']);
  assert.match(bound.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(await call(base, 'bind_qq', { qq: '123456789' }), bound);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_robot_bindings')).rows.length, 1);
  assert.equal((await db.query<{ legacy_table: string | null }>("SELECT to_regclass('naruto_login.qq_number_bindings') AS legacy_table")).rows[0].legacy_table, null);
  const owner = await call(base, 'qq_to_userid', { qq: '123456789' });
  assert.deepEqual(owner, bound);
  const requested = await call(base, 'request_qrcode', { userId: owner.userId, requestId, loginType: 'ios_wechat' });
  const ready = await call(base, 'get_qrcode_status', { userId: owner.userId, taskId: requested.taskId });
  assert.equal(ready.status, 'success');
  assert.equal(ready.url, 'https://fixture-bucket.oss-cn-shanghai.aliyuncs.com/login/qr.png?fixture=signed');
  assert(Date.parse(ready.expiresAt) <= Date.now() + 60000);
  await call(base, 'unbind_qq', { userId: owner.userId });
  assert.equal((await call(base, 'qq_to_userid', { qq: '123456789' })).code, 'MCP_QQ_NOT_BOUND');
});

test('登录网站发码后MCP立即绑定该账号，替换自动账号且网页无需二次确认', async t => {
  const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
  const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users(
    id uuid PRIMARY KEY, username text NOT NULL, username_key text NOT NULL UNIQUE, password text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), is_invalid boolean NOT NULL DEFAULT true,
    is_admin boolean NOT NULL DEFAULT false, admin_note text NOT NULL DEFAULT '');`);
  await db.query(`INSERT INTO naruto_login.users(id,username,username_key,password,is_invalid)
    VALUES ($1,'website-user','website-user','fixture-password',false)`, [userId]);
  const pool: McpQqBindingPool = { async connect() { return { async query(sql, values) {
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows };
  }, release() {} }; }, async end() {} };
  const appConfig = loadConfig({ HYRZ_MCP_TOKEN: secret,
    DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture' });
  const store = new PgMcpQqBindingStore(appConfig, { beforeInitialize: async () => {}, pool });
  const robotStore = new PgQqRobotBindingStore(appConfig, { beforeInitialize: async () => {}, pool });
  const service = new McpQqBindingService(appConfig, { beforeInitialize: async () => {}, store, robotStore });
  const deps = dependencies(); deps.mcpBindings = service;
  const base = await fixture(t, deps, appConfig);
  t.after(async () => { await service.close(); await db.close(); });
  const auto = await call(base, 'bind_qq', { qq: '123456789' }); assert.notEqual(auto.userId, userId);
  const cookie = { Cookie: 'naruto_session=fixture.cookie.signature', 'Content-Type': 'application/json' };
  const response = await fetch(`${base}/api/qq-number-binding/challenge`, { method: 'POST', headers: cookie, body: '{}' });
  assert.equal(response.status, 201); const challenge = await response.json();
  assert.match(challenge.code, /^[A-Za-z0-9_-]{24}$/);
  const bound = await call(base, 'bind_qq', { qq: '123456789', bindingCode: challenge.code });
  assert.deepEqual(bound, { qq: '123456789', userId });
  const status = await (await fetch(`${base}/api/qq-number-binding`, { headers: cookie })).json();
  assert.equal(status.binding.qq, '123456789'); assert.equal(status.challenge, null);
  assert(!JSON.stringify(status).includes(challenge.code));
  assert.deepEqual(await call(base, 'bind_qq', { qq: '123456789', bindingCode: challenge.code }), bound);
  assert.equal((await call(base, 'bind_qq', { qq: '987654321', bindingCode: challenge.code })).status, 'error');
  assert.deepEqual(await call(base, 'qq_to_userid', { qq: '123456789' }), bound);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 2, '转绑保留旧账号且不额外注册');
  assert.equal((await fetch(`${base}/api/qq-number-binding`, { method: 'DELETE', headers: cookie })).status, 204);
  assert.equal((await call(base, 'bind_qq', { qq: '123456789', bindingCode: challenge.code })).status, 'error');
  assert.equal((await db.query('SELECT * FROM naruto_login.qq_robot_bindings')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM naruto_login.users')).rows.length, 2);
});

test('确认时 Cookie 已换账号必须拒绝写入，原账号仍可消费原令牌', async t => {
  const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
  const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
  const db = new PGlite();
  await db.exec('CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users(id uuid PRIMARY KEY,is_invalid boolean NOT NULL DEFAULT false);');
  const displayedId = 'abcdef00-abcd-4bcd-abcd-abcdef123456';
  await db.query('INSERT INTO naruto_login.users(id) VALUES ($1), ($2)', [displayedId, otherUserId]);
  const pool: McpQqBindingPool = { async connect() { return { async query(sql, values) {
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows };
  }, release() {} }; }, async end() {} };
  const appConfig = loadConfig({ HYRZ_MCP_TOKEN: secret, HYRZ_PUBLIC_URL: 'https://site.example',
    DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture' });
  const store = new PgMcpQqBindingStore(appConfig, { beforeInitialize: async () => {}, pool });
  const service = new McpQqBindingService(appConfig, { beforeInitialize: async () => {}, store });
  const deps = dependencies(); deps.mcpBindings = service;
  deps.auth.getUser = async value => ({ id: value === 'other.cookie.signature' ? otherUserId : displayedId,
    username: '受控账号', isAdmin: false }) as never;
  const base = await fixture(t, deps, appConfig);
  t.after(async () => { await service.close(); await db.close(); });
  const pending = await service.create('123456789');
  const challenge = new URL(pending.bindingUrl).hash.slice('#mcp-bind='.length);
  const send = (action: string, cookie: string, body: unknown) => fetch(`${base}/api/mcp-bindings/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `naruto_session=${cookie}` }, body: JSON.stringify(body),
  });
  assert.equal((await send('preview', 'fixture.cookie.signature', { token: challenge })).status, 200);
  const rejected = await send('confirm', 'other.cookie.signature', { token: challenge, expectedUserId: displayedId });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'MCP_BINDING_ACCOUNT_CHANGED');
  assert.deepEqual((await db.query('SELECT * FROM naruto_login.qq_number_bindings')).rows, []);
  assert.deepEqual((await db.query('SELECT status, user_id FROM naruto_login.qq_number_binding_requests')).rows,
    [{ status: 'pending', user_id: null }]);
  assert.equal((await send('confirm', 'fixture.cookie.signature', {
    token: challenge, expectedUserId: displayedId.toUpperCase(),
  })).status, 200);
  assert.deepEqual(await service.resolve('123456789'), { qq: '123456789', userId: displayedId });
});
