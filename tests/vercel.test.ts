import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';

test('Vercel 入口无需本地监听配置，识别 HTTPS 同源请求并保留 API 错误响应', async () => {
  const previous = { ...process.env };
  delete process.env.REDIS_URL;
  process.env.STORAGE_DRIVER = 'local';
  const { default: app } = await import('../api/index.js');
  process.env = previous;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-Forwarded-Proto': 'https', Origin: `https://127.0.0.1:${address.port}` };
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const response = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, 'REDIS_NOT_CONFIGURED');
    const crossSite = await fetch(`${base}/api/login-sessions`, { method: 'POST', headers: { ...headers, Origin: 'https://unrelated.example' } });
    assert.equal(crossSite.status, 403);
    const missing = await fetch(`${base}/api/unknown`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
