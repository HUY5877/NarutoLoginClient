import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { LoginEvent, LoginEventStore } from '../src/server/database.js';
import { ApiError } from '../src/server/errors.js';
import { LoginEventService } from '../src/server/login-events.js';
import type { Submission, Task } from '../src/server/queue.js';
import { loginFailure } from '../src/shared/task-errors.js';

function fixture() {
  let time = Date.now();
  const records = new Map<string, LoginEvent>();
  const queue = new Map<string, Task>();
  const submissions: Submission[] = [];
  const store: LoginEventStore = {
    initialize: async () => {},
    async reserve(candidate, now) {
      for (const record of records.values()) {
        if (record.userId === candidate.userId && !record.finishedAt && Date.parse(record.expiresAt) <= +now) {
          record.status = 'expired'; record.finishedAt = now.toISOString();
        }
      }
      const same = [...records.values()].find(r => r.userId === candidate.userId && r.requestId === candidate.requestId);
      if (same) return { ...same };
      const active = await this.getActive(candidate.userId, now);
      if (active) return active;
      records.set(candidate.id, { ...candidate });
      return { ...candidate };
    },
    async getActive(userId, now) {
      const record = [...records.values()].find(r => r.userId === userId && !r.finishedAt && Date.parse(r.expiresAt) > +now);
      return record ? { ...record } : null;
    },
    async getEvent(id, userId) { const r = records.get(id); return r?.userId === userId ? { ...r } : null; },
    async getLatestForUser(userId) {
      return [...records.values()].filter(r => r.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
    },
    async markDispatched(id, _userId, now) { records.get(id)!.dispatchedAt = now.toISOString(); },
    async updateStatus(id, _userId, status, now) {
      const record = records.get(id)!;
      record.status = status;
      if (['failed', 'expired'].includes(status)) record.finishedAt = now.toISOString();
    },
  };
  const tasks = {
    async enqueue(task: Submission) {
      assert(records.has(task.id), 'event must be durable before enqueue');
      submissions.push(task);
      if (!queue.has(task.id)) queue.set(task.id, {
        id: task.id, status: 'queued', createdAt: task.createdAt, expiresAt: task.expiresAt, simulation: true,
      });
    },
    async getForUser(id: string, userId: string) {
      const task = queue.get(id);
      if (!task || records.get(id)?.userId !== userId) throw new ApiError(404, 'missing');
      return { ...task };
    },
  };
  const service = () => new LoginEventService({ sessionTtlMs: 120000 }, { store, tasks, now: () => time });
  return { records, queue, submissions, store, tasks, service, advance(ms: number) { time += ms; } };
}

test('事件先持久化再入队，刷新与新的服务实例恢复相同申请且不暴露内部凭据', async () => {
  const f = fixture(), userId = randomUUID(), requestId = randomUUID();
  const task = await f.service().create(userId, requestId);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(task.id)?.requestId, requestId);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(await f.service().getActive(userId), task);
  assert.deepEqual(await f.service().create(userId, requestId), task);
  assert.deepEqual(await f.service().create(userId, randomUUID()), task);
  assert.equal(f.submissions.length, 1);
  assert(!('accessToken' in task)); assert(!('userId' in task));
});

test('Redis已接收但响应丢失时，读取事件以相同ID及凭据重试而不创建第二条任务', async () => {
  const f = fixture(), userId = randomUUID(), requestId = randomUUID();
  const enqueue = f.tasks.enqueue;
  let first = true;
  f.tasks.enqueue = async task => {
    await enqueue(task);
    if (first) { first = false; throw new ApiError(503, 'lost reply'); }
  };
  await assert.rejects(f.service().create(userId, requestId), { status: 503 });
  const before = [...f.records.values()][0];
  assert.equal(before.dispatchedAt, null);
  f.queue.get(before.id)!.status = 'opening_game';
  const recovered = await f.service().getActive(userId);
  assert.equal(recovered?.id, before.id);
  assert.equal(recovered?.status, 'opening_game');
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[0].id, f.submissions[1].id);
  assert.equal(f.submissions[0].accessToken, f.submissions[1].accessToken);
  assert.equal(f.queue.size, 1);
  assert.equal(f.records.size, 1);
  assert(f.records.get(before.id)?.dispatchedAt);
});

test('确认投递写数据库失败后，恢复仍使用同一事件，不丢失原申请', async () => {
  const f = fixture(), userId = randomUUID();
  const mark = f.store.markDispatched;
  f.store.markDispatched = async () => { throw new Error('private database URL'); };
  await assert.rejects(f.service().create(userId, randomUUID()), { code: 'LOGIN_EVENTS_UNAVAILABLE' });
  f.store.markDispatched = mark;
  const result = await f.service().getActive(userId);
  assert(result);
  assert.equal(f.queue.size, 1);
  assert.equal(f.records.size, 1);
});

test('已投递事件在Redis记录丢失后仍阻止新申请，不再次入队', async () => {
  const f = fixture(), userId = randomUUID();
  const task = await f.service().create(userId, randomUUID());
  f.queue.clear();
  assert.equal((await f.service().getActive(userId))?.id, task.id);
  assert.equal((await f.service().create(userId, randomUUID())).id, task.id);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.records.size, 1);
});

test('过期事件停止显示；重放旧requestId仍返回过期，新的requestId才创建新任务', async () => {
  const f = fixture(), userId = randomUUID(), requestId = randomUUID();
  const task = await f.service().create(userId, requestId);
  f.advance(120001);
  assert.equal(await f.service().getActive(userId), null);
  assert.equal((await f.service().getForUser(task.id, userId)).status, 'expired');
  const replay = await f.service().create(userId, requestId);
  assert.equal(replay.id, task.id); assert.equal(replay.status, 'expired');
  assert.equal(f.submissions.length, 1);
  assert.notEqual((await f.service().create(userId, randomUUID())).id, task.id);
});

test('工作进程失败会持久化并释放当前事件，用户可发起下一次申请', async () => {
  const f = fixture(), userId = randomUUID();
  const task = await f.service().create(userId, randomUUID());
  f.queue.get(task.id)!.status = 'failed';
  assert.equal(await f.service().getActive(userId), null);
  assert.equal(f.records.get(task.id)?.status, 'failed');
  assert(f.records.get(task.id)?.finishedAt);
  assert.notEqual((await f.service().create(userId, randomUUID())).id, task.id);
});

test('跨账户不能恢复或读取事件；数据库查询失败不能伪装没有活跃申请', async () => {
  const f = fixture(), userId = randomUUID(), other = randomUUID();
  const task = await f.service().create(userId, randomUUID());
  assert.equal(await f.service().getActive(other), null);
  await assert.rejects(f.service().getForUser(task.id, other), { status: 404 });
  f.store.getActive = async () => { throw new Error('private connection'); };
  await assert.rejects(f.service().getActive(userId), { status: 503, code: 'LOGIN_EVENTS_UNAVAILABLE' });
});

test('选项先持久化，丢失投递响应后的重试和有效事件复用始终沿用原选择', async () => {
  const f = fixture(), userId = randomUUID(), requestId = randomUUID();
  const enqueue = f.tasks.enqueue;
  let first = true;
  f.tasks.enqueue = async task => {
    await enqueue(task);
    if (first) { first = false; throw new ApiError(503, 'lost reply'); }
  };
  const selected = { equipmentStamina: false };
  await assert.rejects(f.service().create(userId, requestId, selected), { status: 503 });
  selected.equipmentStamina = true;
  const recovered = await f.service().create(userId, requestId, selected);
  assert.deepEqual(recovered.userOptions, { equipmentStamina: false });
  assert.deepEqual(f.records.get(recovered.id)?.userOptions, { equipmentStamina: false });
  assert.equal(f.submissions.length, 2);
  for (const submission of f.submissions) assert.deepEqual(submission.userOptions, { equipmentStamina: false });
  assert.deepEqual((await f.service().create(userId, randomUUID(), selected)).userOptions, { equipmentStamina: false });
  assert.deepEqual((await f.service().getForUser(recovered.id, userId)).userOptions, { equipmentStamina: false });
  assert.equal(f.queue.size, 1);
  assert.equal(f.submissions.length, 2);
  // Losing Redis must not lose the persisted selection or re-enqueue the task.
  f.queue.clear();
  assert.deepEqual((await f.service().getActive(userId))?.userOptions, { equipmentStamina: false });
  assert.equal(f.submissions.length, 2);
  f.advance(120001);
  const next = await f.service().create(userId, randomUUID(), selected);
  assert.notEqual(next.id, recovered.id);
  assert.deepEqual(next.userOptions, { equipmentStamina: true });
});

test('失败原因在首次读取、数据库已标记失败后的复查及原二维码到期后保持，不重新派发', async () => {
  const f = fixture(), userId = randomUUID();
  const original = await f.service().create(userId, randomUUID());
  Object.assign(f.queue.get(original.id)!, { status: 'failed', errorCode: 'worker_clock_skew', error: 'private connection failure' });
  const first = await f.service().getForUser(original.id, userId);
  assert.equal(first.status, 'failed');
  assert.deepEqual({ error: first.error, errorCode: first.errorCode }, loginFailure('worker_clock_skew'));
  assert.equal(f.records.get(original.id)?.status, 'failed');
  assert.deepEqual(await f.service().getForUser(original.id, userId), first);
  f.advance(120001);
  assert.deepEqual(await f.service().getForUser(original.id, userId), first);
  assert.equal(f.submissions.length, 1);
  await assert.rejects(f.service().getForUser(original.id, randomUUID()), { status: 404 });
});

test('失败会话过期或 Redis 不可用仍保留数据库失败结果，迟到正常状态不可复活', async () => {
  const f = fixture(), userId = randomUUID();
  const original = await f.service().create(userId, randomUUID());
  Object.assign(f.queue.get(original.id)!, { status: 'failed', errorCode: 'worker_clock_skew' });
  await f.service().getForUser(original.id, userId);
  const expected = { ...original, status: 'failed', ...loginFailure(undefined) };
  Object.assign(f.queue.get(original.id)!, { status: 'queued' });
  assert.deepEqual(await f.service().getForUser(original.id, userId), expected);
  f.queue.clear();
  f.advance(120001);
  assert.deepEqual(await f.service().getForUser(original.id, userId), expected);
  f.tasks.getForUser = async () => { throw new ApiError(503, 'private redis details'); };
  assert.deepEqual(await f.service().getForUser(original.id, userId), expected);
  assert.equal(f.submissions.length, 1);
});
