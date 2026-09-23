import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';

test('Vercel 入口无需本地监听配置，识别 HTTPS 同源请求并保留 API 错误响应', async () => {
  const previous = { ...process.env };
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_URL;
  process.env.STORAGE_DRIVER = 'local';
  const { default: app } = await import('../api/index.js');
  process.env = previous;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: `https://127.0.0.1:${address.port}` };
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const me = await fetch(`${base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { user: null });
    const response = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'AUTH_REQUIRED');
    for (const route of ['/api/login-sessions/active', '/api/login-sessions/123e4567-e89b-42d3-a456-426614174000']) {
      const unauthenticated = await fetch(`${base}${route}`);
      assert.equal(unauthenticated.status, 401);
      assert.equal((await unauthenticated.json() as { code: string }).code, 'AUTH_REQUIRED');
    }
    const crossSite = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers: { ...headers, Origin: 'https://unrelated.example' }, body: '{}' });
    assert.equal(crossSite.status, 403);
    const missing = await fetch(`${base}/api/unknown`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
