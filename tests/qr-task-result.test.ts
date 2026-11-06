import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import type { LoginEvent, LoginEventStore } from '../src/server/database.js';
import { LoginEventService } from '../src/server/login-events.js';
import { DEFAULT_USER_OPTIONS } from '../src/shared/user-options.js';
import type { Task } from '../src/server/queue.js';
import { QrTaskResultService } from '../src/server/qr-task-result.js';
import { createObjectReader, type ObjectReader } from '../src/server/storage.js';

const userId = '123e4567-e89b-42d3-a456-426614174001';
const taskId = '123e4567-e89b-42d3-a456-426614174000';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const signedUrl = 'https://fixture-bucket.oss-cn-shanghai.aliyuncs.com/login/qr.png?Signature=fixture';

function fixture() {
  let time = Date.parse('2026-11-06T01:00:00.000Z');
  const task: Task = { id: taskId, status: 'preparing_qr', createdAt: new Date(time).toISOString(),
    expiresAt: new Date(time + 120_000).toISOString(), simulation: true, qrRevision: 'one' };
  const statuses: string[] = [];
  const events = {
    async getForUser(id: string, owner: string) {
      if (id !== taskId || owner !== userId) throw new ApiError(404, 'private database detail');
      return { ...task };
    },
    async recordStatus(id: string, owner: string, status: Task['status']) {
      assert.equal(id, taskId); assert.equal(owner, userId); statuses.push(status); task.status = status;
    },
  };
  const storage: ObjectReader = { async exists() { return true; }, async read() { return png; },
    async signUrl(id, ttl) { assert.equal(id, taskId); assert.ok(ttl > 0 && ttl <= 60); return signedUrl; } };
  return { task, events, storage, statuses, advance(ms: number) { time += ms; },
    service: () => new QrTaskResultService({ events, storage, now: () => time }) };
}

test('没有图片时继续准备，旧 qr_ready 会回写 preparing_qr', async () => {
  const f = fixture(); f.storage.read = async () => null;
  assert.deepEqual(await f.service().get(userId, taskId), { status: 'running', taskId, pollAfterMs: 1000 });
  f.task.status = 'qr_ready';
  assert.equal((await f.service().get(userId, taskId)).status, 'running');
  assert.deepEqual(f.statuses, ['preparing_qr']);
});

test('有效 PNG 才返回最长六十秒的链接，较短剩余期限向下取整', async () => {
  const f = fixture();
  assert.deepEqual(await f.service().get(userId, taskId), { status: 'success', taskId, url: signedUrl,
    expiresAt: '2026-11-06T01:01:00.000Z' });
  f.advance(100_500);
  f.storage.signUrl = async (_id, ttl) => { assert.equal(ttl, 19); return signedUrl; };
  assert.deepEqual(await f.service().get(userId, taskId), { status: 'success', taskId, url: signedUrl,
    expiresAt: '2026-11-06T01:01:59.000Z' });
});

test('失败、中断、过期、已扫码和已授权任务都不能返回二维码', async () => {
  const cases: Partial<Task>[] = [ { status: 'failed', error: 'credential secret' }, { status: 'expired' },
    { runStatus: 'failed' }, { runStatus: 'interrupted' }, { runStatus: 'expired' },
    { loginAuthorized: true }, { scanCaptured: true }, { runStatus: 'finishing_login' },
    { runStatus: 'running_daily' }, { runStatus: 'completed' } ];
  for (const state of cases) {
    const f = fixture(); Object.assign(f.task, state);
    f.storage.read = async () => { assert.fail('ended task must not read image'); };
    const result = await f.service().get(userId, taskId);
    assert.equal(result.status, 'error'); assert.doesNotMatch(JSON.stringify(result), /credential secret|Signature=/);
  }
});

test('刷新中不读取旧图片，到期或不足一秒时不签发链接', async () => {
  const f = fixture(); f.task.refreshRequestId = 'refresh';
  f.storage.read = async () => { assert.fail('refresh must not read old image'); };
  assert.equal((await f.service().get(userId, taskId)).status, 'running');
  delete f.task.refreshRequestId; f.storage.read = async () => png;
  f.storage.signUrl = async () => { assert.fail('expired task must not sign'); };
  f.advance(119_500);
  assert.equal((await f.service().get(userId, taskId)).status, 'error');
  f.advance(500);
  assert.equal((await f.service().get(userId, taskId)).status, 'error');
});

test('无效 PNG 和本地模式明确返回错误，不伪造签名链接', async () => {
  const f = fixture(); f.storage.read = async () => Buffer.from('not a PNG');
  f.storage.signUrl = async () => { assert.fail('invalid image must not sign'); };
  const invalid = await f.service().get(userId, taskId);
  assert.equal(invalid.status, 'error');
  if (invalid.status === 'error') assert.equal(invalid.code, 'QR_INVALID_IMAGE');
  f.storage.read = async () => png; delete f.storage.signUrl;
  const local = await f.service().get(userId, taskId);
  assert.equal(local.status, 'error');
  if (local.status === 'error') assert.equal(local.code, 'QR_STORAGE_UNSUPPORTED');
});

test('读图或签名期间刷新、换图、扫码、失败和过期后不能成功', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.task.qrRevision = 'two'; }, f => { f.task.refreshRequestId = 'refresh'; },
    f => { f.task.scanCaptured = true; }, f => { f.task.loginAuthorized = true; },
    f => { f.task.status = 'failed'; }, f => { f.task.runStatus = 'completed'; },
    f => { f.advance(120_000); },
  ];
  for (const phase of ['read', 'sign'] as const) {
    for (const change of changes) {
      const f = fixture();
      if (phase === 'read') f.storage.read = async () => { change(f); return png; };
      else f.storage.signUrl = async () => { change(f); return signedUrl; };
      const result = await f.service().get(userId, taskId);
      assert.notEqual(result.status, 'success', `${phase} must reject changed QR`);
      assert.doesNotMatch(JSON.stringify(result), /Signature=/);
    }
  }
});

test('签名过程中任务期限缩短，不能返回超过新期限的链接', async () => {
  const f = fixture();
  f.storage.signUrl = async () => { f.task.expiresAt = '2026-11-06T01:00:02.000Z'; return signedUrl; };
  assert.equal((await f.service().get(userId, taskId)).status, 'running');
});

test('每次读取都核对用户归属，错误内容不泄露依赖细节', async () => {
  const f = fixture();
  await assert.rejects(f.service().get('123e4567-e89b-42d3-a456-426614174002', taskId),
    (error: unknown) => error instanceof ApiError && error.status === 404 && !error.message.includes('private'));
  let calls = 0;
  f.events.getForUser = async () => { if (++calls > 1) throw new ApiError(404, 'private database detail'); return { ...f.task }; };
  const result = await f.service().get(userId, taskId).catch(error => error);
  assert.ok(result instanceof ApiError || result.status === 'error');
  assert.doesNotMatch(JSON.stringify(result), /private|Signature=/);
});

test('读图和签名未知异常以及非 HTTPS 结果都转换成安全错误', async () => {
  for (const phase of ['read', 'sign', 'url'] as const) {
    const f = fixture();
    if (phase === 'read') f.storage.read = async () => { throw new Error('OSS credential secret'); };
    else f.storage.signUrl = async () => { if (phase === 'sign') throw new Error(signedUrl); return 'http://unsafe.example/qr'; };
    const result = await f.service().get(userId, taskId);
    assert.equal(result.status, 'error'); assert.doesNotMatch(JSON.stringify(result), /credential|Signature=|unsafe/);
  }
});

test('用户和任务必须是 UUID v4，不访问依赖', async () => {
  const f = fixture(); f.events.getForUser = async () => { assert.fail('invalid UUID must not access events'); };
  for (const value of ['', '../secret', '123e4567-e89b-12d3-a456-426614174000']) {
    await assert.rejects(f.service().get(userId, value), { status: 400 });
    await assert.rejects(f.service().get(value, taskId), { status: 400 });
  }
});

test('OSS 签名绑定固定对象、HTTPS 和六十秒上限，本地 reader 无签名能力', async () => {
  const config = loadConfig({ STORAGE_DRIVER: 'oss', OSS_REGION: 'oss-cn-shanghai', OSS_BUCKET: 'fixture-bucket',
    OSS_ACCESS_KEY_ID: 'fixture-id', OSS_ACCESS_KEY_SECRET: 'fixture-secret' });
  const reader = createObjectReader(config);
  assert.equal(typeof reader.signUrl, 'function');
  const before = Math.floor(Date.now() / 1000);
  const url = new URL(await reader.signUrl!(taskId, 120));
  assert.equal(url.protocol, 'https:'); assert.equal(url.pathname, `/login/${taskId}/qr.png`);
  assert.equal(url.searchParams.get('OSSAccessKeyId'), 'fixture-id');
  assert.ok(Number(url.searchParams.get('Expires')) <= before + 61);
  assert.ok(Number(url.searchParams.get('Expires')) >= before + 60);
  assert.ok(url.searchParams.get('Signature'));
  assert.equal(createObjectReader(loadConfig({})).signUrl, undefined);
  await assert.rejects(reader.signUrl!(taskId, 0), { status: 410 });
  await assert.rejects(reader.signUrl!('../invalid', 30), { status: 400 });
});

test('OSS 签名 SDK 异常返回安全错误，不暴露签名和凭据', async t => {
  const OSS = createRequire(new URL('../src/server/package.json', import.meta.url))('ali-oss') as {
    prototype: { signatureUrl(key: string, options: { expires: number }): string };
  };
  t.mock.method(OSS.prototype, 'signatureUrl', () => { throw new Error('fixture-secret Signature=leak'); });
  const reader = createObjectReader(loadConfig({ STORAGE_DRIVER: 'oss', OSS_REGION: 'oss-cn-shanghai',
    OSS_BUCKET: 'fixture-bucket', OSS_ACCESS_KEY_ID: 'fixture-id', OSS_ACCESS_KEY_SECRET: 'fixture-secret' }));
  await assert.rejects(reader.signUrl!(taskId, 30), (error: unknown) => error instanceof ApiError
    && error.status === 503 && !/fixture-secret|Signature=/.test(error.message));
});

// Exercise the actual website recovery service. A high-level events stub cannot
// expose its PostgreSQL fallback or prove that strict reads avoid dispatch.
function liveFixture() {
  const now = Date.parse('2026-11-06T01:00:00Z');
  const event: LoginEvent = { id: taskId, userId, requestId: taskId, accessToken: 'fixture-token',
    status: 'qr_ready', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString(),
    dispatchedAt: new Date(now).toISOString(), finishedAt: null, userOptions: { ...DEFAULT_USER_OPTIONS }, loginType: 'android_qq' };
  let live: Task | undefined = { id: taskId, status: 'qr_ready', runStatus: 'waiting_scan', qrRevision: 'one',
    createdAt: event.createdAt, expiresAt: event.expiresAt, simulation: true,
    userOptions: { mainTask: 'arena_weekly', equipmentStamina: false, secretRealmMode: 'skip' }, loginType: 'ios_wechat' };
  let reads = 0, imageReads = 0, signs = 0;
  const store: LoginEventStore = {
    initialize: async () => {},
    getEvent: async (id, owner) => id === taskId && owner === userId ? { ...event } : null,
    updateStatus: async (_id, _owner, status) => { event.status = status; },
    reserve: async () => assert.fail('strict reads must not reserve'),
    getActive: async () => assert.fail('strict reads must not recover'),
    getLatestForUser: async () => assert.fail('strict reads must not replay'),
    markDispatched: async () => assert.fail('strict reads must not dispatch'),
  };
  const tasks = { enqueue: async () => assert.fail('strict reads must not enqueue'),
    getForUser: async (id: string, owner: string, requested?: LoginEvent) => {
      reads++;
      assert.equal(id, taskId); assert.equal(owner, userId); assert.deepEqual(requested, event);
      if (!live) throw new ApiError(404, 'private Redis detail');
      return { ...live };
    } };
  const events = new LoginEventService({ sessionTtlMs: 120000 }, { store, tasks, now: () => now });
  const storage: ObjectReader = { exists: async () => true, read: async () => { imageReads++; return png; },
    signUrl: async () => { signs++; return signedUrl; } };
  return { events, event, storage, tasks, get live() { return live!; }, lose: () => { live = undefined; },
    counts: () => ({ reads, imageReads, signs }),
    service: () => new QrTaskResultService({ events, storage, now: () => now }) };
}

test('真实事件服务在已扫码后丢失 Redis 记录仍拒绝二维码，网页摘要回退保持原样', async () => {
  const f = liveFixture(); f.live.loginAuthorized = true;
  const scanned = await f.service().get(userId, taskId);
  assert.equal(scanned.status, 'error');
  if (scanned.status === 'error') assert.equal(scanned.code, 'QR_UNAVAILABLE');
  f.lose();
  const lost = await f.service().get(userId, taskId);
  assert.equal(lost.status, 'error');
  assert.deepEqual(f.counts(), { reads: 2, imageReads: 0, signs: 0 });
  assert.equal((await f.events.getForUser(taskId, userId)).status, 'qr_ready');
});

for (const phase of ['initial', 'read', 'sign'] as const) {
  test(`真实事件服务在 ${phase} 阶段丢失 Redis 不返回链接，签名前丢失不签发`, async () => {
    const f = liveFixture();
    if (phase === 'initial') f.lose();
    if (phase === 'read') f.storage.read = async () => { f.lose(); return png; };
    if (phase === 'sign') f.storage.signUrl = async () => { f.lose(); return signedUrl; };
    const result = await f.service().get(userId, taskId);
    assert.equal(result.status, 'error', phase);
    assert.doesNotMatch(JSON.stringify(result), /Signature=|private Redis/);
    if (phase !== 'sign') assert.equal(f.counts().signs, 0);
  });
}

test('实时读取保留任务参数和归属，未投递记录不重放，持久失败不被旧 Redis 状态复活', async () => {
  const f = liveFixture();
  const current = await f.events.getForUser(taskId, userId, { requireLive: true });
  assert.deepEqual(current.userOptions, f.live.userOptions);
  assert.equal(current.loginType, 'ios_wechat');
  const before = f.counts().reads;
  await assert.rejects(f.events.getForUser(taskId, '123e4567-e89b-42d3-a456-426614174002', { requireLive: true }), { status: 404 });
  assert.equal(f.counts().reads, before);
  f.event.dispatchedAt = null;
  assert.equal((await f.events.getForUser(taskId, userId, { requireLive: true })).status, 'qr_ready');
  f.event.status = 'failed';
  assert.equal((await f.events.getForUser(taskId, userId, { requireLive: true })).status, 'failed');
  assert.equal((await f.service().get(userId, taskId)).status, 'error');
  f.lose();
  await assert.rejects(f.events.getForUser(taskId, userId, { requireLive: true }), { status: 503, code: 'TASK_STATE_UNAVAILABLE' });
});

test('真实事件服务仅活跃扫码任务能签名，读取和签名期间的扫码、刷新及版本变化被拒绝', async () => {
  const active = liveFixture();
  assert.equal((await active.service().get(userId, taskId)).status, 'success');
  assert.deepEqual(active.counts(), { reads: 3, imageReads: 1, signs: 1 });
  const mutations: ((task: Task) => void)[] = [task => { task.scanCaptured = true; },
    task => { task.refreshRequestId = 'refresh'; }, task => { task.qrRevision = 'two'; }];
  for (const phase of ['read', 'sign'] as const) for (const mutate of mutations) {
    const f = liveFixture();
    if (phase === 'read') f.storage.read = async () => { mutate(f.live); return png; };
    else f.storage.signUrl = async () => { mutate(f.live); return signedUrl; };
    const result = await f.service().get(userId, taskId);
    assert.notEqual(result.status, 'success');
    assert.doesNotMatch(JSON.stringify(result), /Signature=/);
  }
});
