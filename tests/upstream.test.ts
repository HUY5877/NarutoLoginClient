import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { test } from 'node:test';
import { loadConfig } from '../src/server/config.js';
import { createObjectReader } from '../src/server/storage.js';
import { TaskService } from '../src/server/upstream.js';

async function serve(handler: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  try { await run(`http://127.0.0.1:${addr.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('上游短暂不可用时用相同 ID 和 token 重试', async () => {
  const received: unknown[] = [];
  await serve((req, res) => {
    assert.equal(req.headers['x-service-token'], 'local-development-token');
    let body = '';
    req.on('data', data => { body += String(data); });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(received.length === 1 ? 503 : 202).end('{}');
    });
  }, async url => {
    const service = new TaskService(loadConfig({ LOGIN_SERVICE_URL: url }));
    const submission = { id: 'same-task-id', accessToken: 'same-token', createdAt: 'now', expiresAt: 'later' };
    await service.enqueue(submission);
    assert.deepEqual(received, [submission, submission]);
  });
});

test('上游非法 JSON 对象返回受控 502，不抛空指针错误', async () => {
  await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('null'), async url => {
    const service = new TaskService(loadConfig({ LOGIN_SERVICE_URL: url }));
    await assert.rejects(service.get('some-id', 'token'), { status: 502 });
  });
});

test('上游响应头后卡住，仍然受整个请求超时限制', async () => {
  await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); }, async url => {
    const service = new TaskService(loadConfig({ LOGIN_SERVICE_URL: url, UPSTREAM_TIMEOUT_MS: '100' }));
    await assert.rejects(service.get('some-id', 'token'), { status: 502 });
  });
});

test('模拟 OSS 在服务端用 HEAD 查状态、GET 读内容，404 表示尚未存在', async () => {
  const methods: string[] = [];
  await serve((req, res) => {
    assert.equal(req.headers['x-service-token'], 'local-development-token');
    methods.push(req.method!);
    res.writeHead(req.url?.includes('missing') ? 404 : 200).end('png-data');
  }, async url => {
    const reader = createObjectReader(loadConfig({ LOGIN_SERVICE_URL: url }));
    assert.equal(await reader.exists('present'), true);
    assert.equal((await reader.read('present'))?.toString(), 'png-data');
    assert.equal(await reader.exists('missing'), false);
    assert.equal(await reader.read('missing'), null);
    assert.deepEqual(methods, ['HEAD', 'GET', 'HEAD', 'GET']);
  });
});

test('存储读取正文中断转为受控 503', async () => {
  await serve((_req, res) => { res.writeHead(200); res.flushHeaders(); }, async url => {
    const reader = createObjectReader(loadConfig({ LOGIN_SERVICE_URL: url, UPSTREAM_TIMEOUT_MS: '100' }));
    await assert.rejects(reader.read('present'), { status: 503 });
  });
});
