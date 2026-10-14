import { strict as assert } from 'node:assert';
import { AsyncResource } from 'node:async_hooks';
import { once, type EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createApp, type Dependencies } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { PgAuthStore } from '../src/server/database.js';
import { logBackend, requestLogContext, safeError } from '../src/server/logging.js';

test('底层异常只保留分类、错误码和源文件位置，不记录消息、凭证、SQL或驱动参数', t => {
  const secret = 'sensitive-password-and-token';
  const cause = Object.assign(new Error(`postgres://user:${secret}@host/database`), { code: 'ECONNRESET' });
  const error = Object.assign(new Error(`SELECT '${secret}'`), { code: '57014', cause,
    detail: secret, hint: secret, parameters: [secret], config: { password: secret } });
  error.stack = `Error: ${secret}\n    at work (E:\\private-directory\\database.ts:14:8)\n    at postgres://${secret}\n    at query (/var/task/index.js:20:10)`;
  const diagnostic = safeError(error);
  assert.equal(diagnostic.code, '57014');
  assert.equal(diagnostic.category, 'query_timeout');
  assert.deepEqual(diagnostic.stack, ['database.ts:14:8', 'index.js:20:10']);
  assert.equal((diagnostic.cause as Record<string, unknown>).category, 'connection_reset');
  assert.doesNotMatch(JSON.stringify(diagnostic), /sensitive|SELECT|postgres|private-directory/);
  t.mock.method(console, 'error', () => { throw new Error('log sink unavailable'); });
  assert.doesNotThrow(() => logBackend('error', 'test.failed', { error }));
  assert.doesNotThrow(() => logBackend('error', 'test.failed', { error: {
    get code() { throw new Error('broken driver diagnostic'); },
  } }));
});

test('并发失败请求分别关联依赖错误与503，成功和预期401不刷日志', async t => {
  const output: string[] = [];
  t.mock.method(console, 'error', (line: string) => { output.push(line); });
  const secret = 'private-cookie-password-query-value';
  const auth: Dependencies['auth'] = {
    async getUser(token) {
      if (!token) return null;
      await new Promise(resolve => setTimeout(resolve, token.includes('first') ? 10 : 2));
      logBackend('error', 'auth.database_failed', { component: 'auth', phase: 'query', operation: 'find_active_user',
        error: Object.assign(new Error(`postgres://${secret}`), { code: 'ETIMEDOUT' }) });
      throw new ApiError(503, '账号服务暂时不可用，请稍后重试。', 'AUTH_UNAVAILABLE');
    },
    login: async () => { throw new ApiError(401, '用户名或密码错误。', 'INVALID_CREDENTIALS'); },
    register: async () => { throw new ApiError(400, '无效的申请。'); },
    listApplications: async () => ({ applications: [] }),
    reviewApplication: async () => { throw new ApiError(404, '申请不存在。'); },
  };
  const app = createApp(loadConfig({}), {
    auth, events: {} as Dependencies['events'], storage: { exists: async () => false, read: async () => null },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const responses = await Promise.all(['first', 'second'].map(value => fetch(`${base}/api/auth/me?token=${secret}`, {
      headers: { Cookie: `naruto_session=header.${value}.signature; unrelated=${secret}`, 'x-vercel-id': 'sin1::iad1::test-request' },
    })));
    const ids = responses.map(response => response.headers.get('x-request-id'));
    assert.notEqual(ids[0], ids[1]);
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: '账号服务暂时不可用，请稍后重试。', code: 'AUTH_UNAVAILABLE' });
      const related = output.map(line => JSON.parse(line)).filter(line => line.requestId === ids[index]);
      assert.equal(related.length, 2);
      assert.ok(related.every(line => line.path === '/api/auth/me' && line.method === 'GET'));
      assert.equal(related[0].event, 'auth.database_failed');
      assert.equal(related[0].error.category, 'connection_timeout');
      assert.equal(related[1].event, 'api.request_failed');
      assert.equal(related[1].status, 503);
      assert.ok(related[1].durationMs >= 0);
    }
    assert.doesNotMatch(output.join(''), /private-cookie|header\.first|header\.second|postgres:\/\//);
    const count = output.length;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 200);
    const unauthorized = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-user', password: secret }) });
    assert.equal(unauthorized.status, 401);
    assert.equal(output.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('初始化故障区分取连接、锁等待和建表阶段，记录后仍回滚、丢弃连接并允许重试', async t => {
  const { Pool } = createRequire(new URL('../src/server/package.json', import.meta.url))('pg');
  const output: string[] = [];
  t.mock.method(console, 'error', (line: string) => { output.push(line); });
  for (const stage of ['acquire_connection', 'schema_lock', 'schema_apply']) {
    output.length = 0;
    const failure = Object.assign(new Error('private database detail and password'), { code: stage === 'acquire_connection' ? 'ETIMEDOUT' : '57014' });
    let fail = true;
    let discarded = false;
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        const operation = sql.includes('pg_advisory_xact_lock') ? 'schema_lock' : sql.includes('CREATE SCHEMA') ? 'schema_apply' : sql;
        queries.push(operation);
        if (fail && operation === stage) { fail = false; throw failure; }
        return { rows: [] };
      },
      release(broken: boolean) { discarded = broken; },
    };
    const mocked = t.mock.method(Pool.prototype, 'connect', async () => {
      if (fail && stage === 'acquire_connection') { fail = false; throw failure; }
      return client;
    });
    const store = new PgAuthStore('postgres://fixture:private-password@invalid/fixture', 1000);
    try {
      await assert.rejects(store.initialize(), error => error === failure);
      assert.equal(output.length, 1);
      const diagnostic = JSON.parse(output[0]);
      assert.equal(diagnostic.operation, stage);
      assert.equal(diagnostic.timeoutMs, 1000);
      assert.equal(diagnostic.error.code, failure.code);
      assert.equal(diagnostic.poolWaiting, 0);
      assert.equal(queries.includes('ROLLBACK'), stage !== 'acquire_connection');
      assert.equal(discarded, stage !== 'acquire_connection');
      assert.doesNotMatch(output[0], /private|postgres:\/\//);
      await store.initialize();
      assert.equal(queries.at(-1), 'COMMIT');
      assert.equal(output.length, 1);
    } finally { await store.close(); mocked.mock.restore(); }
  }
});

test('空闲连接异常保留连接池标识，不误关联已经结束的请求', async t => {
  const output: string[] = [];
  t.mock.method(console, 'error', (line: string) => { output.push(line); });
  const store = new PgAuthStore('postgres://fixture:private-password@invalid/fixture');
  const socket = requestLogContext.run({ requestId: 'already-finished-request', method: 'GET', path: '/api/auth/me' },
    () => new AsyncResource('idle-socket-fixture'));
  try {
    socket.runInAsyncScope(() => (store as unknown as { pool: EventEmitter }).pool.emit('error',
      Object.assign(new Error('private idle connection detail'), { code: 'ECONNRESET' })));
    assert.equal(output.length, 1);
    const diagnostic = JSON.parse(output[0]);
    assert.equal(diagnostic.event, 'postgres.idle_connection_failed');
    assert.equal(diagnostic.error.category, 'connection_reset');
    assert.ok(diagnostic.storeId);
    assert.equal(diagnostic.requestId, undefined);
    assert.equal(diagnostic.path, undefined);
    assert.doesNotMatch(output[0], /private|already-finished/);
  } finally { socket.emitDestroy(); await store.close(); }
});
