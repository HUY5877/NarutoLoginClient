import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError, type Submission, type Task } from '../src/server/upstream.js';

const config = loadConfig({});
const id = '123e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(64);
const start = Date.now();
const baseTask: Task = { id, status: 'opening_game', createdAt: new Date(start).toISOString(),
  expiresAt: new Date(start + 120000).toISOString(), simulation: true };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

async function withApi(deps: Partial<Dependencies>, run: (base: string) => Promise<void>) {
  const app = createApp(config, {
    tasks: { enqueue: async () => {}, get: async () => ({ ...baseTask }) },
    storage: { exists: async () => false, read: async () => png },
    now: () => start,
    ...deps,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const headers = { Authorization: `Bearer ${token}` };

test('每次申请生成独立 ID 和随机凭证，先投递队列，再返回客户端', async () => {
  const submitted: Submission[] = [];
  await withApi({ tasks: { enqueue: async task => { submitted.push(task); }, get: async () => baseTask } }, async base => {
    const responses = await Promise.all([1, 2].map(async () => {
      const response = await fetch(`${base}/api/login-sessions`, { method: 'POST' });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return await response.json() as Submission & { simulation: boolean };
    }));
    assert.equal(submitted.length, 2);
    assert.notEqual(responses[0].id, responses[1].id);
    assert.notEqual(responses[0].accessToken, responses[1].accessToken);
    assert.match(responses[0].accessToken, /^[a-f0-9]{64}$/);
    assert.equal(Date.parse(responses[0].expiresAt) - Date.parse(responses[0].createdAt), 120000);
    assert.equal(responses[0].simulation, true);
    assert.deepEqual(submitted[0], { id: responses[0].id, accessToken: responses[0].accessToken, createdAt: responses[0].createdAt, expiresAt: responses[0].expiresAt });
  });
});

test('队列投递失败不返回成功，不泄露内部错误', async () => {
  await withApi({ tasks: { enqueue: async () => { throw new Error('secret sdk path'); }, get: async () => baseTask } }, async base => {
    const response = await fetch(`${base}/api/login-sessions`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret sdk path/);
  });
});

test('跨站请求被拒绝，允许配置的开发前端源', async () => {
  await withApi({}, async base => {
    const denied = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers: { Origin: 'https://unrelated.example' } });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.equal(allowed.status, 202);
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
  await withApi({ tasks: { enqueue: async () => {}, get: async () => ({ ...baseTask, status: 'qr_ready' }) } }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    assert.equal((await response.json() as Task).status, 'preparing_qr');
  });
});

test('缺少凭证、错误凭证和无效 ID 不允许读取二维码存储', async () => {
  await withApi({ tasks: { enqueue: async () => {}, get: async () => { throw new ApiError(404, 'not found'); } },
    storage: { exists: async () => { assert.fail('must not probe'); }, read: async () => { assert.fail('must not read'); } } }, async base => {
    assert.equal((await fetch(`${base}/api/login-sessions/${id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/login-sessions/invalid`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/login-sessions/${id}`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 404);
  });
});

test('过期会话停止存储访问，图片接口返回 410', async () => {
  await withApi({ now: () => start + 120000,
    storage: { exists: async () => { assert.fail('must not probe'); }, read: async () => { assert.fail('must not read'); } } }, async base => {
    const response = await fetch(`${base}/api/login-sessions/${id}`, { headers });
    assert.equal((await response.json() as Task).status, 'expired');
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 410);
  });
});

test('读取过程中过期的图片也不能送给客户端', async () => {
  let current = start;
  await withApi({ now: () => current, storage: { exists: async () => true, read: async () => { current += 120000; return png; } } }, async base => {
    assert.equal((await fetch(`${base}/api/login-sessions/${id}/qr`, { headers })).status, 410);
  });
});

test('图片返回 PNG 且禁用缓存；缺失图片为 404', async () => {
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

test('非法 JSON 使用统一 JSON 错误响应', async () => {
  await withApi({}, async base => {
    const response = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: '请求格式无效。' });
  });
});

test('OSS 必需配置、TTL 和网络监听配置在启动时校验', () => {
  assert.throws(() => loadConfig({ STORAGE_DRIVER: 'oops' }), /STORAGE_DRIVER/);
  assert.throws(() => loadConfig({ STORAGE_DRIVER: 'oss' }), /OSS_REGION/);
  assert.throws(() => loadConfig({ SESSION_TTL_MS: 'NaN' }), /SESSION_TTL_MS/);
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /SERVICE_TOKEN/);
  assert.throws(() => loadConfig({ LOGIN_SERVICE_URL: 'file:///secret' }), /LOGIN_SERVICE_URL/);
  assert.throws(() => loadConfig({ OSS_KEY_PREFIX: '../escape' }), /OSS_KEY_PREFIX/);
});
