import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { McpQqBindingService, PgMcpQqBindingStore, type McpQqBindingPool } from '../src/server/mcp-qq-bindings.js';

const userId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '10000000-0000-4000-8000-000000000002';
const taskId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const secret = 'fixture-backend-only-key-1234567890123456';
const token = 'A'.repeat(43);
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
      create: async (qq: string) => ({ qq, bindingUrl: `https://site.example/#mcp-bind=${token}`, expiresAt: '2099-11-06T00:05:00.000Z' }),
      preview: async () => ({ qq: '123456789', expiresAt: '2099-11-06T00:05:00.000Z' }),
      confirm: async (id: string) => ({ qq: '123456789', userId: id, boundAt: '2026-11-06T00:00:00.000Z' }),
      resolve: async (qq: string) => ({ qq, userId }),
      unbind: async (id: string) => ({ userId: id, status: 'unbound' }),
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

test('绑定链接按每次MCP连接的地址生成，无需额外配置网站地址', async t => {
  const deps = dependencies();
  const origins: unknown[] = [];
  deps.mcpBindings!.create = async (qq, origin?: string) => {
    origins.push(origin);
    return { qq, bindingUrl: `${origin}/#mcp-bind=${token}`, expiresAt: '2099-11-06T00:05:00.000Z' };
  };
  const base = await fixture(t, deps, loadConfig({ HYRZ_MCP_TOKEN: secret }));
  const results = await Promise.all(Array.from({ length: 3 }, () => call(base, 'bind_qq', { qq: '123456789' })));
  assert.deepEqual(origins, [base, base, base]);
  assert(results.every(result => result.bindingUrl === `${base}/#mcp-bind=${token}`));
});

test('反代并发连接各自保留地址与协议，不采用客户端伪造的转发域名', async t => {
  const deps = dependencies();
  deps.mcpBindings!.create = async (qq, origin?: string) => {
    await new Promise(resolve => setImmediate(resolve));
    return { qq, bindingUrl: `${origin}/#mcp-bind=${token}`, expiresAt: '2099-11-06T00:05:00.000Z' };
  };
  const base = await fixture(t, deps, loadConfig({ HYRZ_MCP_TOKEN: secret }), true);
  for (const version of ['2026-07-28', '2025-11-25']) {
    const results = await Promise.all(['https', 'http'].map(protocol =>
      call(base, 'bind_qq', { qq: '123456789' }, { 'X-Forwarded-Proto': protocol,
        'X-Forwarded-Host': 'untrusted.example', 'MCP-Protocol-Version': version })));
    assert.deepEqual(results.map(result => result.bindingUrl), ['https', 'http'].map(protocol => `${protocol}://${new URL(base).host}/#mcp-bind=${token}`));
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

test('hyrz QQ绑定只返回确认链接，解析和解绑由专用工具执行', async t => {
  const base = await fixture(t);
  const binding = await call(base, 'bind_qq', { qq: '123456789' });
  assert.equal(binding.qq, '123456789');
  assert.equal(binding.bindingUrl, `https://site.example/#mcp-bind=${token}`);
  assert.deepEqual(await call(base, 'qq_to_userid', { qq: '123456789' }), { qq: '123456789', userId });
  assert.deepEqual(await call(base, 'unbind_qq', { userId }), { userId, status: 'unbound' });
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
  deps2.mcpBindings!.resolve = async () => { throw new Error('secret=should-never-appear'); };
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

test('真实MCP串起QQ确认、用户解析、二维码提交查询和解绑，数据库只持久化确认后的身份', async t => {
  const requireServer = createRequire(new URL('../src/server/package.json', import.meta.url));
  const { PGlite } = requireServer('@electric-sql/pglite') as typeof import('../src/server/node_modules/@electric-sql/pglite/dist/index.js');
  const db = new PGlite();
  await db.exec('CREATE SCHEMA naruto_login; CREATE TABLE naruto_login.users(id uuid PRIMARY KEY,is_invalid boolean NOT NULL DEFAULT false);');
  await db.query('INSERT INTO naruto_login.users(id) VALUES ($1)', [userId]);
  const pool: McpQqBindingPool = { async connect() { return { async query(sql, values) {
    const result = values ? await db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows };
  }, release() {} }; }, async end() {} };
  const appConfig = loadConfig({ HYRZ_MCP_TOKEN: secret,
    DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture' });
  const store = new PgMcpQqBindingStore(appConfig, { beforeInitialize: async () => {}, pool });
  const bindingService = new McpQqBindingService(appConfig, { beforeInitialize: async () => {}, store });
  const deps = dependencies();
  deps.mcpBindings = bindingService;
  deps.storage.read = async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  deps.storage.signUrl = async () => 'https://fixture-bucket.oss-cn-shanghai.aliyuncs.com/login/qr.png?fixture=signed';
  const base = await fixture(t, deps, appConfig);
  t.after(async () => { await bindingService.close(); await db.close(); });
  const pending = await call(base, 'bind_qq', { qq: '123456789' });
  assert.equal((await call(base, 'qq_to_userid', { qq: '123456789' })).code, 'MCP_QQ_NOT_BOUND');
  const link = new URL(pending.bindingUrl);
  assert.equal(link.origin, base);
  const confirm = await fetch(`${base}/api/mcp-bindings/confirm`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: 'naruto_session=fixture.cookie.signature',
  }, body: JSON.stringify({ token: link.hash.slice('#mcp-bind='.length), expectedUserId: userId }) });
  assert.equal(confirm.status, 200);
  const owner = await call(base, 'qq_to_userid', { qq: '123456789' });
  assert.equal(owner.userId, userId);
  const requested = await call(base, 'request_qrcode', { userId: owner.userId, requestId, loginType: 'ios_wechat' });
  const ready = await call(base, 'get_qrcode_status', { userId: owner.userId, taskId: requested.taskId });
  assert.equal(ready.status, 'success');
  assert.equal(ready.url, 'https://fixture-bucket.oss-cn-shanghai.aliyuncs.com/login/qr.png?fixture=signed');
  assert(Date.parse(ready.expiresAt) <= Date.now() + 60000);
  await call(base, 'unbind_qq', { userId: owner.userId });
  assert.equal((await call(base, 'qq_to_userid', { qq: '123456789' })).code, 'MCP_QQ_NOT_BOUND');
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
