import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { AdminService } from '../src/server/admin.js';
import { createApp } from '../src/server/app.js';
import type { User } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { TaskRunService, type RunRedisDriver } from '../src/server/task-runs.js';

const taskId = '123e4567-e89b-42d3-a456-426614174000';
const now = Date.parse('2026-10-22T02:11:05.531Z');
const administrator: User = { id: '456e7890-e89b-42d3-a456-426614174001', username: 'admin', isAdmin: true };
const ordinary: User = { ...administrator, username: 'ordinary', isAdmin: false };
const adminToken = 'eyJhbGciOiJIUzI1NiJ9.admin.signature';
const ordinaryToken = 'eyJhbGciOiJIUzI1NiJ9.ordinary.signature';
const adminHeaders = { Cookie: `naruto_session=${adminToken}`, 'Content-Type': 'application/json' };
const expected = { taskId, status: 'interrupted' as const };
const unexpected = async (): Promise<never> => assert.fail('中断任务不能读取数据库、派发任务或操作二维码');
const interrupt = (service: TaskRunService, id: string) => service.interrupt(id);
const interruptAs = (service: AdminService, actor: User, id: string) => service.interruptDailyTask(actor, id);
const errorIs = (status: number, code?: string) => (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, status);
  if (code !== undefined) assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /private-credential|redis:\/\//);
  return true;
};

function fixture() {
  const config = { redisUrl: 'redis://private-credential', redisQueueKey: 'selected:test:tasks', timeoutMs: 100 };
  const operations: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  let result: unknown = 1;
  let connectFailure: Error | undefined;
  let commandFailure: Error | undefined;
  let ready = false;
  let connections = 0;
  const driver: RunRedisDriver = {
    get isReady() { return ready; },
    async connect() {
      connections++;
      if (connectFailure) throw connectFailure;
      ready = true;
    },
    async eval(script, options) {
      operations.push({ script, ...options });
      if (commandFailure) throw commandFailure;
      return result;
    },
    destroy() { ready = false; },
  };
  const service = new TaskRunService(config, { now: () => now, createDriver: () => driver,
    store: { initialize: unexpected, getEvent: unexpected, getLatestForUser: unexpected } });
  return { service, config, operations,
    result(value: unknown) { result = value; },
    failConnect(error: Error) { connectFailure = error; },
    failCommand(error: Error) { commandFailure = error; },
    get connections() { return connections; },
  };
}

function adminService(runs: TaskRunService) {
  return new AdminService({ runs: { getSummaries: unexpected, getFailureDetails: unexpected,
    getAdminLogPage: unexpected, interrupt: id => interrupt(runs, id) } });
}

test('管理员中断只对所选 namespace 的 runs key 发起一次原子写入，并保留 TTL', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await interrupt(f.service, taskId), expected);
    assert.equal(f.operations.length, 1);
    assert.equal(f.connections, 1);
    const operation = f.operations[0];
    assert.deepEqual(operation.keys, [`${f.config.redisQueueKey}:runs:${taskId}`]);
    assert.deepEqual(operation.arguments, [taskId, new Date(now).toISOString()]);
    assert.match(operation.script, /redis\.call\(['"]GET['"]/);
    assert.match(operation.script, /redis\.call\(['"]SET['"]/);
    assert.match(operation.script, /KEEPTTL/);
    assert.match(operation.script, /cjson\.decode/);
    assert.match(operation.script, /cjson\.encode/);
    assert.doesNotMatch(operation.script, /redis\.(?:call|pcall)\(['"](?:DEL|LPUSH|RPUSH|BRPOP|EXPIRE|PEXPIRE|PUBLISH|XADD)['"]/);
    assert.doesNotMatch(operation.script, /KEYS\[[2-9]\]|:sessions:|:users:|:active/);
  } finally { f.service.close(); }
});

test('已经中断的运行返回相同结果，支持管理员安全重试', async () => {
  const f = fixture();
  try {
    f.result(2);
    assert.deepEqual(await interrupt(f.service, taskId), expected);
    assert.deepEqual(await interrupt(f.service, taskId), expected);
    assert.equal(f.operations.length, 2);
    assert.equal(f.connections, 1);
  } finally { f.service.close(); }
});

test('非法任务编号在连接 Redis 前拒绝，不能碰任何其他 key', async () => {
  const f = fixture();
  try {
    for (const invalid of ['', 'invalid', ` ${taskId}`, `${taskId}\n`, `${taskId}/other`, '../sessions',
      '123e4567-e89b-12d3-a456-426614174000']) {
      await assert.rejects(interrupt(f.service, invalid), errorIs(400));
    }
    assert.equal(f.connections, 0);
    assert.equal(f.operations.length, 0);
  } finally { f.service.close(); }
});

test('不存在、已结束和损坏的运行各自返回明确错误，未知 Redis 返回不能当作成功', async () => {
  const f = fixture();
  try {
    for (const [result, status, code] of [
      [0, 404, 'TASK_RUN_NOT_FOUND'], [3, 409, 'TASK_NOT_RUNNING'], [-1, 502, 'TASK_RUN_DATA_INVALID'],
      [4, 502, 'TASK_RUN_DATA_INVALID'], [null, 502, 'TASK_RUN_DATA_INVALID'],
      [undefined, 502, 'TASK_RUN_DATA_INVALID'], ['1', 502, 'TASK_RUN_DATA_INVALID'],
      [true, 502, 'TASK_RUN_DATA_INVALID'], [[], 502, 'TASK_RUN_DATA_INVALID'], [{}, 502, 'TASK_RUN_DATA_INVALID'],
    ] as const) {
      f.result(result);
      await assert.rejects(interrupt(f.service, taskId), errorIs(status, code));
    }
  } finally { f.service.close(); }
});

test('Redis 连接和写入失败均返回现有 503 错误且不泄露连接内容', async () => {
  for (const phase of ['connect', 'command'] as const) {
    const f = fixture();
    try {
      const error = new Error('redis://private-credential connection refused');
      if (phase === 'connect') f.failConnect(error); else f.failCommand(error);
      await assert.rejects(interrupt(f.service, taskId), errorIs(503, 'TASK_LOGS_UNAVAILABLE'));
    } finally { f.service.close(); }
  }
});

test('AdminService 先检查管理员权限，获授权后只转交任务编号', async () => {
  const f = fixture();
  const admin = adminService(f.service);
  try {
    await assert.rejects(interruptAs(admin, ordinary, taskId), errorIs(403, 'ADMIN_REQUIRED'));
    assert.equal(f.connections, 0);
    assert.equal(f.operations.length, 0);
    assert.deepEqual(await interruptAs(admin, administrator, taskId), expected);
    assert.equal(f.operations.length, 1);
  } finally { f.service.close(); }
});

async function withApi(admin: AdminService | undefined, run: (base: string) => Promise<void>) {
  const config = loadConfig({});
  const app = createApp(config, {
    admin,
    auth: { register: unexpected, login: unexpected, listApplications: unexpected, reviewApplication: unexpected,
      getUser: async token => token === adminToken ? administrator : token === ordinaryToken ? ordinary : null },
    events: { create: unexpected, getForUser: unexpected, getActive: unexpected, recordStatus: unexpected },
    storage: { exists: unexpected, read: unexpected },
    now: () => now,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('POST 中断接口使用 Cookie 管理员与路径编号，返回中断结果且不派发新任务', async () => {
  const f = fixture();
  try {
    await withApi(adminService(f.service), async base => {
      const path = `${base}/api/admin/daily-tasks/${taskId}/interrupt`;
      const response = await fetch(path, { method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ taskId: administrator.id, workerId: 'ignored', attemptId: 'ignored' }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(f.operations[0].keys, [`${f.config.redisQueueKey}:runs:${taskId}`]);
      assert.equal(f.operations[0].arguments[0], taskId);
      assert.equal(f.operations.length, 1);
    });
  } finally { f.service.close(); }
});

test('中断接口拒绝匿名、普通账户、跨站请求和错误格式，拒绝期间不访问 Redis', async () => {
  const f = fixture();
  try {
    await withApi(adminService(f.service), async base => {
      const path = `${base}/api/admin/daily-tasks/${taskId}/interrupt`;
      for (const [headers, status, code] of [
        [{ 'Content-Type': 'application/json' }, 401, 'AUTH_REQUIRED'],
        [{ ...adminHeaders, Cookie: `naruto_session=${ordinaryToken}` }, 403, 'ADMIN_REQUIRED'],
        [{ ...adminHeaders, Origin: 'https://hostile.example' }, 403, undefined],
        [{ ...adminHeaders, 'Sec-Fetch-Site': 'cross-site' }, 403, undefined],
        [{ ...adminHeaders, 'Content-Type': 'text/plain' }, 415, undefined],
      ] as const) {
        const response = await fetch(path, { method: 'POST', headers, body: '{}' });
        assert.equal(response.status, status);
        if (code) assert.equal((await response.json()).code, code);
      }
      assert.equal(f.connections, 0);
      assert.equal(f.operations.length, 0);
    });
  } finally { f.service.close(); }
});

test('中断接口拒绝非法路径编号和 GET 请求，未配置管理服务时返回 503', async () => {
  const f = fixture();
  try {
    await withApi(adminService(f.service), async base => {
      const invalid = await fetch(`${base}/api/admin/daily-tasks/invalid/interrupt`,
        { method: 'POST', headers: adminHeaders, body: '{}' });
      assert.equal(invalid.status, 400);
      assert.equal((await fetch(`${base}/api/admin/daily-tasks/${taskId}/interrupt`, { headers: adminHeaders })).status, 404);
      assert.equal(f.operations.length, 0);
      assert.equal(f.connections, 0);
    });
    await withApi(undefined, async base => {
      const response = await fetch(`${base}/api/admin/daily-tasks/${taskId}/interrupt`,
        { method: 'POST', headers: adminHeaders, body: '{}' });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'ADMIN_UNAVAILABLE');
    });
  } finally { f.service.close(); }
});

test('中断接口保留业务错误码，不把不存在或已结束的任务显示成成功', async () => {
  const f = fixture();
  try {
    await withApi(adminService(f.service), async base => {
      for (const [result, status, code] of [[0, 404, 'TASK_RUN_NOT_FOUND'], [3, 409, 'TASK_NOT_RUNNING'],
        [-1, 502, 'TASK_RUN_DATA_INVALID']] as const) {
        f.result(result);
        const response = await fetch(`${base}/api/admin/daily-tasks/${taskId}/interrupt`,
          { method: 'POST', headers: adminHeaders, body: '{}' });
        assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
      }
    });
  } finally { f.service.close(); }
});
