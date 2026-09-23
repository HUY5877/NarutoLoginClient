import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { TaskService, type RedisDriver, type Submission } from '../src/server/queue.js';

const now = Date.now();
const config = { redisUrl: 'redis://localhost:6379', redisQueueKey: 'naruto:login:tasks', timeoutMs: 100, ossPrefix: 'login' };
const task: Submission = { id: '123e4567-e89b-42d3-a456-426614174000', accessToken: 'a'.repeat(64),
  createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString() };
const stored = { id: task.id, status: 'queued', createdAt: task.createdAt, expiresAt: task.expiresAt,
  simulation: true, tokenHash: createHash('sha256').update(task.accessToken).digest('hex') };

function driver(overrides: Partial<RedisDriver> = {}): RedisDriver {
  return { isReady: true, connect: async () => {}, eval: async () => 1,
    get: async () => JSON.stringify(stored), destroy() {}, ...overrides };
}

test('未配置 Redis 时返回明确 503，不创建连接', async () => {
  const service = new TaskService({ ...config, redisUrl: undefined }, () => { assert.fail('must not connect'); }, () => now);
  for (const request of [() => service.enqueue(task), () => service.get(task.id, task.accessToken)]) {
    await assert.rejects(request, { status: 503, code: 'REDIS_NOT_CONFIGURED', message: 'Redis 未配置，请先配置 REDIS_URL。' });
  }
});

test('原子提交会话与 LPUSH 任务，队列不含浏览器凭证，TTL 只保留剩余有效期', async () => {
  const service = new TaskService(config, () => driver({ eval: async (_script, options, signal) => {
    assert.deepEqual(options.keys, [config.redisQueueKey, `${config.redisQueueKey}:sessions:${task.id}`]);
    assert.deepEqual(JSON.parse(options.arguments[0]), stored);
    assert.equal(options.arguments[1], '119000');
    assert.deepEqual(JSON.parse(options.arguments[2]), { version: 1, id: task.id, createdAt: task.createdAt,
      expiresAt: task.expiresAt, objectKey: `login/${task.id}/qr.png` });
    assert.ok(!options.arguments.join('').includes(task.accessToken));
    assert.equal(signal.aborted, false);
    return 1;
  } }), () => now + 1000);
  await service.enqueue(task);
});

test('Redis 返回既有会话时视为成功，重复提交保留原申请内容', async () => {
  const calls: unknown[] = [];
  const service = new TaskService(config, () => driver({ eval: async (_script, options) => {
    calls.push(options); return calls.length === 1 ? 1 : 0;
  } }), () => now);
  await service.enqueue(task);
  await service.enqueue(task);
  assert.deepEqual(calls[0], calls[1]);
  const invalid = new TaskService(config, () => driver({ eval: async () => 'unexpected' }), () => now);
  await assert.rejects(invalid.enqueue(task), { status: 502 });
});

test('并发请求复用一次 Redis 连接', async () => {
  let factories = 0;
  let connects = 0;
  const connection = driver({ isReady: false, connect: async () => { connects++; } });
  const service = new TaskService(config, () => { factories++; return connection; }, () => now);
  await Promise.all([service.enqueue(task), service.get(task.id, task.accessToken), service.get(task.id, task.accessToken)]);
  assert.equal(factories, 1);
  assert.equal(connects, 1);
});

test('会话读取验证凭证，只返回客户端可见字段', async () => {
  const service = new TaskService(config, () => driver({ get: async key => {
    assert.equal(key, `${config.redisQueueKey}:sessions:${task.id}`);
    return JSON.stringify({ ...stored, privateInternalError: 'secret' });
  } }), () => now);
  assert.deepEqual(await service.get(task.id, task.accessToken), { id: task.id, status: 'queued',
    createdAt: task.createdAt, expiresAt: task.expiresAt, simulation: true });
  await assert.rejects(service.get(task.id, 'wrong-token'), { status: 404 });
  const missing = new TaskService(config, () => driver({ get: async () => null }), () => now);
  await assert.rejects(missing.get(task.id, task.accessToken), { status: 404 });
});

test('过期申请拒绝入队，读取时标记 expired', async () => {
  const expired = new TaskService(config, () => { assert.fail('must not connect'); }, () => now + 120000);
  await assert.rejects(expired.enqueue(task), { status: 410 });
  const service = new TaskService(config, () => driver(), () => now + 120000);
  assert.equal((await service.get(task.id, task.accessToken)).status, 'expired');
});

test('损坏的 Redis 记录返回受控错误，失败原因不从内部转发', async () => {
  for (const value of ['null', '{', JSON.stringify({ ...stored, tokenHash: 'bad' }),
    JSON.stringify({ ...stored, expiresAt: 'tomorrow' }), JSON.stringify({ ...stored, createdAt: task.expiresAt })]) {
    const service = new TaskService(config, () => driver({ get: async () => value }), () => now);
    await assert.rejects(service.get(task.id, task.accessToken), { status: 502 });
  }
  const failed = new TaskService(config, () => driver({ get: async () => JSON.stringify({ ...stored, status: 'failed', error: 'secret' }) }), () => now);
  assert.equal((await failed.get(task.id, task.accessToken)).error, '二维码生成失败，请重新申请。');
});

test('连接和命令超时均有上限，销毁坏连接并隐藏网络凭据', async () => {
  for (const stage of ['connect', 'get'] as const) {
    let destroyed = 0;
    let signal: AbortSignal | undefined;
    const hanging = driver({ isReady: stage !== 'connect',
      connect: () => new Promise<void>(() => {}),
      get: (_key, abortSignal) => { signal = abortSignal; return new Promise<string | null>(() => {}); },
      destroy: () => { destroyed++; } });
    const service = new TaskService({ ...config, timeoutMs: 20 }, () => hanging, () => now);
    await assert.rejects(service.get(task.id, task.accessToken), { status: 503, code: 'REDIS_UNAVAILABLE' });
    assert.equal(destroyed, 1);
    if (stage === 'get') assert.equal(signal?.aborted, true);
  }
  let created = 0;
  const service = new TaskService(config, () => {
    created++;
    return created === 1 ? driver({ get: async () => { throw new Error('redis://user:secret@example.test'); } }) : driver();
  }, () => now);
  await assert.rejects(service.get(task.id, task.accessToken), { status: 503, message: 'Redis 暂时不可用，请检查连接配置后重试。' });
  assert.equal((await service.get(task.id, task.accessToken)).status, 'queued');
  assert.equal(created, 2);
});
