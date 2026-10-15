import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { AuthService } from '../src/server/auth.js';
import { TaskRunService } from '../src/server/task-runs.js';
import { cloudflareTestEnv } from './cloudflare-fixture.js';

async function vercelApp() {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, cloudflareTestEnv, { REDIS_URL: 'redis://obsolete-production.invalid:6379/0',
      DATABASE_URL: 'postgresql://obsolete:secret@production.invalid/prod', STORAGE_DRIVER: 'oss' });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.cloudflare.com');
      if (url.pathname.endsWith('/keys')) {
        assert.equal(url.searchParams.has('prefix'), false);
        assert.match(url.pathname, /\/fixture-prod\/keys$/);
        return Response.json({ success: true, result: ['REDIS_QUEUE_KEY', 'OSS_KEY_PREFIX', 'STORAGE_DRIVER',
          'PORT', 'SESSION_COOKIE_NAME', 'LOCAL_OBJECTS_DIR'].map(name => ({ name })), result_info: { cursor: '' } });
      }
      assert.equal(url.pathname.endsWith('/bulk/get'), true);
      assert.equal(init?.method, 'POST');
      return Response.json({ success: true, result: { values: {
        REDIS_QUEUE_KEY: 'fixture:login:tasks', OSS_KEY_PREFIX: 'fixture-login', STORAGE_DRIVER: 'local',
        PORT: '4300', SESSION_COOKIE_NAME: 'naruto_session', LOCAL_OBJECTS_DIR: 'fixture-objects',
      } } });
    };
    return (await import('../api/index.js')).default;
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
}

test('Vercel 入口无需本地监听配置，识别 HTTPS 同源请求并保留 API 错误响应', async () => {
  const app = await vercelApp();
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
    for (const route of ['/api/login-sessions/active', '/api/login-sessions/123e4567-e89b-42d3-a456-426614174000',
      '/api/task-runs/latest', '/api/task-runs/123e4567-e89b-42d3-a456-426614174000/events']) {
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

test('Vercel 重写参数兼容日志分页，并保留权限、游标及 URL 任务编号校验', async () => {
  const originalGetUser = AuthService.prototype.getUser;
  const originalRead = TaskRunService.prototype.getAdminLogPage;
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  const otherTaskId = '123e4567-e89b-42d3-a456-426614174001';
  const calls: unknown[][] = [];
  AuthService.prototype.getUser = async token => token === 'admin.fixture.signature'
    ? { id: otherTaskId, username: 'admin-fixture', isAdmin: true }
    : token === 'user.fixture.signature' ? { id: otherTaskId, username: 'user-fixture', isAdmin: false } : null;
  TaskRunService.prototype.getAdminLogPage = async (id, after = '0-0', snapshot) => {
    calls.push([id, after, snapshot]);
    const first = after === '0-0' ? 1 : 101;
    const logs = Array.from({ length: 100 }, (_, index) => ({ id: `${first + index}-0`,
      time: '2026-10-14T09:30:00.000Z', level: 'INFO' as const, message: `执行记录 ${first + index}` }));
    return { taskId: id, status: 'completed', logs, nextCursor: `${first + 99}-0`,
      snapshotCursor: '205-0', hasMore: true, truncated: false };
  };
  let server: Server | undefined;
  try {
    const app = await vercelApp();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/admin/daily-tasks/${taskId}/logs`;
    const rewrite = `path=${encodeURIComponent(`admin/daily-tasks/${taskId}/logs`)}`;
    const headers = { Cookie: 'naruto_session=admin.fixture.signature', 'X-Forwarded-Proto': 'https' };
    const attempts: Array<{ headers: Record<string, string>; status: number }> = [{ headers: {}, status: 401 },
      { headers: { Cookie: 'naruto_session=user.fixture.signature' }, status: 403 }];
    for (const attempt of attempts) {
      assert.equal((await fetch(`${base}?after=0-0&${rewrite}`, { headers: attempt.headers })).status, attempt.status);
    }
    assert.deepEqual(calls, []);
    const first = await fetch(`${base}?after=0-0&${rewrite}`, { headers });
    assert.equal(first.status, 200);
    const firstPage = await first.json();
    assert.equal(firstPage.logs.length, 100);
    assert.equal(firstPage.nextCursor, '100-0');
    assert.equal(firstPage.snapshotCursor, '205-0');
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(calls, [[taskId, '0-0', undefined]]);
    const next = await fetch(`${base}?after=100-0&snapshot=205-0&${rewrite}`, { headers });
    assert.equal(next.status, 200);
    const nextPage = await next.json();
    assert.equal(nextPage.logs.length, 100);
    assert.equal(nextPage.logs[0].id, '101-0');
    assert.equal(nextPage.nextCursor, '200-0');
    assert.deepEqual(calls.at(-1), [taskId, '100-0', '205-0']);
    for (const query of ['after=invalid', 'after=1-0&after=2-0', 'after[x]=1-0',
      'snapshot=invalid', 'snapshot=1-0&snapshot=2-0', 'snapshot[x]=1-0', 'after=2-0&snapshot=1-0']) {
      const invalid = await fetch(`${base}?${query}&${rewrite}`, { headers });
      assert.equal(invalid.status, 400, query);
      assert.equal((await invalid.json()).error, '无效的日志读取位置。');
    }
    assert.equal(calls.length, 2);
    const alternateRewrite = `path=${encodeURIComponent(`admin/daily-tasks/${otherTaskId}/logs`)}`;
    assert.equal((await fetch(`${base}?after=0-0&${alternateRewrite}`, { headers })).status, 200);
    assert.deepEqual(calls.at(-1), [taskId, '0-0', undefined]);
    const invalidId = base.replace(taskId, 'invalid');
    assert.equal((await fetch(`${invalidId}?after=0-0&${alternateRewrite}`, { headers })).status, 400);
    assert.equal(calls.length, 3);
  } finally {
    AuthService.prototype.getUser = originalGetUser;
    TaskRunService.prototype.getAdminLogPage = originalRead;
    if (server) {
      const activeServer = server;
      activeServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => activeServer.close(error => error ? reject(error) : resolve()));
    }
  }
});
