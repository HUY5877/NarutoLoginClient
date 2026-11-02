import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { TaskService, type RedisDriver, type Submission } from '../src/server/queue.js';
import { TaskRunService, type RunRedisDriver } from '../src/server/task-runs.js';
import type { LoginEvent } from '../src/server/database.js';

const at = '2026-11-02T01:00:00.000Z', now = Date.parse(at) + 1_200_000;
const id = '123e4567-e89b-42d3-a456-426614174000';
const userId = '456e7890-e89b-42d3-a456-426614174000';
const config = { redisUrl: 'redis://fixture', redisQueueKey: 'test:unified', timeoutMs: 100, ossPrefix: 'login' };
const task: Submission = { id, userId, accessToken: 'a'.repeat(64), createdAt: at,
  expiresAt: new Date(Date.parse(at) + 600_000).toISOString(),
  userOptions: { mainTask: 'arena_weekly', equipmentStamina: true, secretRealmMode: 'all' } };
const stored = { ...task, accessToken: undefined, taskId: id, simulation: true, status: 'running_daily',
  tokenHash: createHash('sha256').update(task.accessToken).digest('hex'), updatedAt: at,
  authorizedAt: at, startedAt: at, finishedAt: null };
const driver = (overrides: Partial<RedisDriver> = {}): RedisDriver => ({
  isReady: true, connect: async () => {}, eval: async () => 1, get: async () => JSON.stringify(stored), destroy() {}, ...overrides,
});

test('排队时即创建完整 runs，保留期与扫码期限分开，不再写 sessions', async () => {
  const service = new TaskService(config, () => driver({ eval: async (script, options) => {
    assert.equal(options.keys[1], `${config.redisQueueKey}:runs:${id}`);
    assert.doesNotMatch(script, /:sessions:/);
    const record = JSON.parse(options.arguments[0]);
    assert.equal(record.taskId, id); assert.equal(record.status, 'queued');
    assert.equal(record.startedAt, null); assert.equal(record.finishedAt, null);
    assert.equal(record.updatedAt, at); assert.equal(record.userId, userId);
    assert(Number(options.arguments[1]) >= 604_800_000);
    return 1;
  } }), () => Date.parse(at));
  await service.enqueue(task);
});

test('授权后的周胜不按扫码日期过期，活动索引读取同一个 run', async () => {
  const read: string[] = [];
  const service = new TaskService(config, () => driver({ get: async key => {
    read.push(key);
    return key.endsWith(':active') ? id : JSON.stringify(stored);
  } }), () => now);
  const current = await service.getActive(userId);
  assert.equal(current?.id, id); assert.equal(current?.status, 'qr_ready');
  assert.equal(current?.runStatus, 'running_daily'); assert.equal(current?.loginAuthorized, true);
  assert.deepEqual(read, [`${config.redisQueueKey}:users:${userId}:active`, `${config.redisQueueKey}:runs:${id}`]);
  assert.doesNotMatch(JSON.stringify(current), /tokenHash|userId|accessToken/);
});

test('刷新首次查询直接返回完整 run，不能只返回旧扫码日期的 task', async () => {
  const event: LoginEvent = { ...task, requestId: id, status: 'expired', dispatchedAt: at, finishedAt: at };
  const redis: RunRedisDriver = { isReady: true, connect: async () => {}, destroy() {},
    eval: async () => [JSON.stringify(stored)] };
  const service = new TaskRunService(config, { store: { initialize: async () => {},
    getLatestForUser: async () => event, getEvent: async () => event }, createDriver: () => redis, now: () => now });
  const result = await service.getLatest(userId);
  assert.equal(result.task?.id, id); assert.equal(result.run?.status, 'running_daily');
  assert.doesNotMatch(JSON.stringify(result), /tokenHash|userId|accessToken/);
  service.close();
});

test('已超过保存期且 run 已清理的旧任务回到待开始，不永久停在状态缺失', async () => {
  const event: LoginEvent = { ...task, requestId: id, status: 'expired', dispatchedAt: at, finishedAt: at };
  const redis: RunRedisDriver = { isReady: true, connect: async () => {}, destroy() {}, eval: async () => [null] };
  const service = new TaskRunService(config, { store: { initialize: async () => {},
    getLatestForUser: async () => event, getEvent: async () => event }, createDriver: () => redis,
    now: () => Date.parse(at) + 604_800_001 });
  assert.deepEqual(await service.getLatest(userId), { task: null, run: null });
  service.close();
});

test('过期等待扫码的完整恢复和后续轮询使用同一终态', async () => {
  const event: LoginEvent = { ...task, requestId: id, status: 'expired', dispatchedAt: at, finishedAt: at };
  const expired = { ...stored, status: 'waiting_scan', authorizedAt: undefined, startedAt: null };
  const redis: RunRedisDriver = { isReady: true, connect: async () => {}, destroy() {},
    eval: async (_script, options) => options.keys.length === 1 ? [JSON.stringify(expired)]
      : [JSON.stringify(expired), [], '', 0, 0] };
  const service = new TaskRunService(config, { store: { initialize: async () => {},
    getLatestForUser: async () => event, getEvent: async () => event }, createDriver: () => redis, now: () => now });
  assert.equal((await service.getLatest(userId)).run?.status, 'expired');
  assert.equal((await service.getEvents(id, userId)).run?.status, 'expired');
  service.close();
});

test('已明确失败而无 run 的旧记录恢复失败结果，后续轮询不清空失败', async () => {
  const event: LoginEvent = { ...task, requestId: id, status: 'failed', dispatchedAt: null, finishedAt: at };
  const redis: RunRedisDriver = { isReady: true, connect: async () => {}, destroy() {},
    eval: async (_script, options) => options.keys.length === 1 ? [null] : [null, [], '', 0, 0] };
  const service = new TaskRunService(config, { store: { initialize: async () => {},
    getLatestForUser: async () => event, getEvent: async () => event }, createDriver: () => redis, now: () => now });
  assert.equal((await service.getLatest(userId)).run?.status, 'failed');
  const result = await service.getEvents(id, userId);
  assert.equal(result.run?.status, 'failed');
  assert.equal(result.run?.finishedAt, at);
  assert.equal(result.run?.errorCode, undefined);
  service.close();
});
