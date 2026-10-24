import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ApiError } from '../src/server/errors.js';
import { TaskService, type RedisDriver, type Submission } from '../src/server/queue.js';
import { loginFailure } from '../src/shared/task-errors.js';

const now = Date.now();
const config = { redisUrl: 'redis://localhost:6379', redisQueueKey: 'naruto:login:tasks', timeoutMs: 100, ossPrefix: 'login' };
const task: Submission = { id: '123e4567-e89b-42d3-a456-426614174000',
  userId: '456e7890-e89b-42d3-a456-426614174000', accessToken: 'a'.repeat(64),
  createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString(),
  userOptions: { equipmentStamina: true, secretRealmMode: 'all' } };
const stored = { id: task.id, userId: task.userId, status: 'queued', createdAt: task.createdAt, expiresAt: task.expiresAt,
  simulation: true, tokenHash: createHash('sha256').update(task.accessToken).digest('hex') };

test('新提交仅写队列、会话和锁，不再创建或追加 Redis 日志', async () => {
  const service = new TaskService(config, () => driver({ eval: async (script, options) => {
    assert.doesNotMatch(script, /XADD|XTRIM|MAXLEN|日志/);
    assert.equal(options.keys.length, 3);
    assert(options.keys.every(key => !key.includes(':logs:')));
    assert.equal(options.arguments.length, 4);
    return 1;
  } }), () => now);
  await service.enqueue(task);
});

test('四个渠道贯穿入队与会话恢复，刷新命令从原会话读取渠道', async () => {
  for (const loginType of ['android_qq', 'ios_qq', 'android_wechat', 'ios_wechat'] as const) {
    let refreshScript = '';
    const service = new TaskService(config, () => driver({
      get: async () => JSON.stringify({ ...stored, loginType }),
      eval: async (script, options) => {
        if (options.keys[0] === config.redisQueueKey) {
          assert.equal(JSON.parse(options.arguments[0]).loginType, loginType);
          assert.equal(JSON.parse(options.arguments[2]).loginType, loginType);
          return 1;
        }
        refreshScript = script;
        return JSON.stringify({ ...stored, loginType, status: 'preparing_qr' });
      },
    }), () => now);
    await service.enqueue({ ...task, loginType });
    assert.equal((await service.getForUser(task.id, task.userId)).loginType, loginType);
    assert.equal((await service.requestRefresh(task.id, task.userId)).loginType, loginType);
    assert.match(refreshScript, /command\.loginType = s\.loginType or 'android_qq'/);
  }
  assert.equal((await new TaskService(config, () => driver(), () => now).getForUser(task.id, task.userId)).loginType, 'android_qq');
  for (const loginType of [null, '', 'invalid', false, []]) {
    const service = new TaskService(config, () => driver({ get: async () => JSON.stringify({ ...stored, loginType }) }), () => now);
    await assert.rejects(service.getForUser(task.id, task.userId), { status: 502 });
  }
});

test('实例租期独立于排队期限，刷新状态只暴露公开字段', async () => {
  const lease = { ...stored, loginStartedAt: new Date(now + 60_000).toISOString(),
    loginExpiresAt: new Date(now + 660_000).toISOString(), refreshSupported: true,
    refreshRequestId: task.id, qrRevision: task.userId, workerId: 'private-worker' };
  const service = new TaskService(config, () => driver({ get: async () => JSON.stringify(lease) }), () => now + 150_000);
  const result = await service.getForUser(task.id, task.userId);
  assert.equal(result.status, 'queued');
  assert.equal(result.expiresAt, lease.loginExpiresAt);
  assert.equal(result.refreshRequestId, task.id);
  assert.equal(result.refreshSupported, true);
  assert(!('tokenHash' in result)); assert(!('workerId' in result)); assert(!('loginExpiresAt' in result));
});

test('刷新写入绑定任务与账户，返回相同任务，执行服务器不支持或已结束时明确拒绝', async () => {
  const service = new TaskService(config, () => driver({ eval: async (_script, options) => {
    assert.deepEqual(options.keys, [`${config.redisQueueKey}:sessions:${task.id}`, `${config.redisQueueKey}:refresh:${task.id}`, `${config.redisQueueKey}:runs:${task.id}`]);
    assert.deepEqual(options.arguments.slice(0, 3), [task.id, task.userId, new Date(now).toISOString()]);
    const command = JSON.parse(options.arguments[3]);
    assert.equal(command.taskId, task.id); assert.equal(command.requestId, options.arguments[4]);
    return JSON.stringify({ ...stored, status: 'preparing_qr', refreshRequestId: command.requestId });
  } }), () => now);
  assert.equal((await service.requestRefresh(task.id, task.userId)).status, 'preparing_qr');
  for (const [result, status] of [[-1, 404], [-2, 410], [-3, 409], [-4, 409]]) {
    const rejected = new TaskService(config, () => driver({ eval: async () => result }), () => now);
    await assert.rejects(rejected.requestRefresh(task.id, task.userId), { status });
  }
});

function driver(overrides: Partial<RedisDriver> = {}): RedisDriver {
  return { isReady: true, connect: async () => {}, eval: async () => 1,
    get: async () => JSON.stringify(stored), destroy() {}, ...overrides };
}

test('扫码接收标记可从会话恢复，刷新在扫码后清理已有请求且不延长租期', async () => {
  let script = '';
  const service = new TaskService(config, () => driver({
    get: async () => JSON.stringify({ ...stored, scanCaptured: true }),
    eval: async value => { script = value; return JSON.stringify({ ...stored, scanCaptured: true, status: 'qr_ready' }); },
  }), () => now);
  assert.equal((await service.getForUser(task.id, task.userId) as unknown as Record<string, unknown>).scanCaptured, true);
  const refreshed = await service.requestRefresh(task.id, task.userId);
  assert.equal((refreshed as unknown as Record<string, unknown>).scanCaptured, true);
  assert.equal(refreshed.loginAuthorized, undefined);
  const captureGuard = script.slice(script.indexOf('if s.scanCaptured == true then'), script.indexOf('if s.refreshSupported'));
  assert.match(script, /type\(run.scanCapturedAt\) == 'string'/);
  assert.match(captureGuard, /s.refreshRequestId = nil/);
  assert.match(captureGuard, /redis.call\('DEL', KEYS\[2\]\)/);
  assert.match(captureGuard, /'KEEPTTL'/);
  assert.match(captureGuard, /return cjson.encode\(s\)/);
  assert.doesNotMatch(captureGuard, /loginAuthorized\s*=|EXPIRE|LPUSH/);
});

test('未配置 Redis 时返回明确 503，不创建连接', async () => {
  const service = new TaskService({ ...config, redisUrl: undefined }, () => { assert.fail('must not connect'); }, () => now);
  for (const request of [() => service.enqueue(task), () => service.get(task.id, task.accessToken),
    () => service.getForUser(task.id, task.userId), () => service.getActive(task.userId)]) {
    await assert.rejects(request, { status: 503, code: 'REDIS_NOT_CONFIGURED', message: 'Redis 未配置，请先配置 REDIS_URL。' });
  }
});

test('原子提交会话与 LPUSH 任务，队列不含浏览器凭证，TTL 只保留剩余有效期', async () => {
  const service = new TaskService(config, () => driver({ eval: async (_script, options, signal) => {
    assert.deepEqual(options.keys, [config.redisQueueKey, `${config.redisQueueKey}:sessions:${task.id}`,
      `${config.redisQueueKey}:users:${task.userId}:active`]);
    assert.deepEqual(JSON.parse(options.arguments[0]), { ...stored, userOptions: task.userOptions, loginType: 'android_qq' });
    assert.equal(options.arguments[1], '119000');
    assert.deepEqual(JSON.parse(options.arguments[2]), { version: 1, id: task.id, createdAt: task.createdAt,
      expiresAt: task.expiresAt, objectKey: `login/${task.id}/qr.png`, userOptions: task.userOptions, loginTimeoutSeconds: 600, loginType: 'android_qq' });
    assert.equal(options.arguments[3], new Date(now + 1000).toISOString());
    assert.equal(options.arguments.length, 4);
    assert.ok(!options.arguments[2].includes(task.userId));
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

test('装备体力和三种秘境模式随统一 userOptions JSON 入队，不拆成独立字段或 key', async () => {
  for (const equipmentStamina of [true, false]) for (const secretRealmMode of ['once', 'all', 'skip'] as const) {
    const userOptions = { equipmentStamina, secretRealmMode };
    const service = new TaskService(config, () => driver({ eval: async (_script, options) => {
      const payload = JSON.parse(options.arguments[2]);
      assert.deepEqual(payload.userOptions, userOptions);
      assert.equal(Object.hasOwn(payload, 'equipmentStamina'), false);
      assert.equal(Object.hasOwn(payload, 'secretRealmOnce'), false);
      assert.equal(Object.hasOwn(payload, 'secretRealmMode'), false);
      assert.equal(Object.hasOwn(payload.userOptions, 'secretRealmOnce'), false);
      assert.deepEqual(JSON.parse(options.arguments[0]).userOptions, userOptions);
      assert.equal(options.keys.length, 3, 'options share the task payload and session, without another Redis key');
      return 1;
    }, get: async () => JSON.stringify({ ...stored, userOptions }) }), () => now);
    await service.enqueue({ ...task, userOptions });
    assert.deepEqual((await service.getForUser(task.id, task.userId)).userOptions, userOptions);
  }
});

test('刷新二维码沿用三种秘境选择，旧会话默认为全部刷取，损坏选项拒绝读取', async () => {
  for (const equipmentStamina of [true, false]) for (const secretRealmMode of ['once', 'all', 'skip'] as const) {
    const userOptions = { equipmentStamina, secretRealmMode };
    const service = new TaskService(config, () => driver({ eval: async (script, options) => {
      assert.deepEqual(options.keys, [`${config.redisQueueKey}:sessions:${task.id}`,
        `${config.redisQueueKey}:refresh:${task.id}`, `${config.redisQueueKey}:runs:${task.id}`]);
      assert.doesNotMatch(script, /s\.userOptions\s*=/);
      assert.equal(Object.hasOwn(JSON.parse(options.arguments[3]), 'userOptions'), false);
      return JSON.stringify({ ...stored, userOptions, status: 'preparing_qr', refreshRequestId: task.id });
    } }), () => now);
    assert.deepEqual((await service.requestRefresh(task.id, task.userId)).userOptions, userOptions);
  }
  for (const equipmentStamina of [true, false]) {
    const service = new TaskService(config, () => driver({
      get: async () => JSON.stringify({ ...stored, userOptions: { equipmentStamina } }),
    }), () => now);
    assert.deepEqual((await service.getForUser(task.id, task.userId)).userOptions,
      { equipmentStamina, secretRealmMode: 'all' });
  }
  for (const secretRealmOnce of [true, false]) {
    const service = new TaskService(config, () => driver({
      get: async () => JSON.stringify({ ...stored, userOptions: { equipmentStamina: false, secretRealmOnce } }),
    }), () => now);
    assert.deepEqual((await service.getForUser(task.id, task.userId)).userOptions,
      { equipmentStamina: false, secretRealmMode: secretRealmOnce ? 'once' : 'all' });
  }
  for (const secretRealmOnce of ['true', 1, null, [], {}]) {
    const service = new TaskService(config, () => driver({
      get: async () => JSON.stringify({ ...stored, userOptions: { equipmentStamina: true, secretRealmOnce } }),
    }), () => now);
    await assert.rejects(service.getForUser(task.id, task.userId), { status: 502 });
  }
  for (const secretRealmMode of ['invalid', true, null, [], {}]) {
    const service = new TaskService(config, () => driver({
      get: async () => JSON.stringify({ ...stored, userOptions: { equipmentStamina: true, secretRealmMode } }),
    }), () => now);
    await assert.rejects(service.getForUser(task.id, task.userId), { status: 502 });
  }
});

test('周胜主任务沿用原队列和 Redis key，提交、会话恢复及刷新保留首次选择', async () => {
  const userOptions = { ...task.userOptions, mainTask: 'arena_weekly' as const };
  const service = new TaskService(config, () => driver({
    eval: async (_script, options) => {
      if (options.keys[0] === config.redisQueueKey) {
        assert.deepEqual(options.keys, [config.redisQueueKey, `${config.redisQueueKey}:sessions:${task.id}`,
          `${config.redisQueueKey}:users:${task.userId}:active`]);
        const payload = JSON.parse(options.arguments[2]);
        assert.deepEqual(payload.userOptions, userOptions);
        assert.equal(Object.hasOwn(payload, 'mainTask'), false);
        assert.deepEqual(JSON.parse(options.arguments[0]).userOptions, userOptions);
        return 1;
      }
      assert.deepEqual(options.keys, [`${config.redisQueueKey}:sessions:${task.id}`,
        `${config.redisQueueKey}:refresh:${task.id}`, `${config.redisQueueKey}:runs:${task.id}`]);
      assert.equal(Object.hasOwn(JSON.parse(options.arguments[3]), 'userOptions'), false);
      return JSON.stringify({ ...stored, userOptions, status: 'preparing_qr' });
    },
    get: async () => JSON.stringify({ ...stored, userOptions }),
  }), () => now);
  await service.enqueue({ ...task, userOptions });
  assert.deepEqual((await service.getForUser(task.id, task.userId)).userOptions, userOptions);
  assert.deepEqual((await service.requestRefresh(task.id, task.userId)).userOptions, userOptions);
  for (const mainTask of [null, '', 'arena', true, 1, [], {}]) {
    const invalid = new TaskService(config, () => driver({
      get: async () => JSON.stringify({ ...stored, userOptions: { ...task.userOptions, mainTask } }),
    }), () => now);
    await assert.rejects(invalid.getForUser(task.id, task.userId), { status: 502 });
  }
});

test('Outbox 重发 Lua 契约只核验不可变身份字段，在账户锁检查和任何写入之前幂等返回', async () => {
  let captured = '';
  const service = new TaskService(config, () => driver({ eval: async script => {
    captured = script;
    return 0;
  } }), () => now);
  await service.enqueue(task);
  // This guards the Lua contract without pretending a mocked eval executes Lua.
  // The real Redis integration verifies worker status changes and retained TTLs.
  const existingStart = captured.indexOf("local existing = redis.call('GET', KEYS[2])");
  const queueCheck = captured.indexOf('local queueType =');
  const activeCheck = captured.indexOf('local activeId =');
  assert.ok(existingStart >= 0 && existingStart < queueCheck && queueCheck < activeCheck);
  const duplicateGuard = captured.slice(existingStart, queueCheck);
  assert.match(duplicateGuard, /pcall\(cjson\.decode, existing\)/);
  for (const field of ['id', 'userId', 'tokenHash', 'createdAt', 'expiresAt']) {
    assert.ok(duplicateGuard.includes(`persisted.${field} == submitted.${field}`), field);
  }
  assert.match(duplicateGuard, /return 0/);
  assert.match(duplicateGuard, /return redis\.error_reply\('Login session already exists'\)/);
  assert.doesNotMatch(duplicateGuard, /persisted\.(?:status|workerId|error)/);
  assert.doesNotMatch(duplicateGuard, /redis\.(?:call|pcall)\('(?:SET|DEL|LPUSH|PEXPIRE|EXPIRE|XADD)'/);
  assert.doesNotMatch(captured, /XADD/);
  assert.doesNotMatch(captured, /activeRaw == ARGV\[1\]/);
});

test('账号已有有效申请返回明确 409，保持 Redis 连接可用', async () => {
  let factories = 0;
  let destroyed = 0;
  let submissions = 0;
  const service = new TaskService(config, () => {
    factories++;
    return driver({ eval: async () => ++submissions === 1 ? -1 : 1, destroy: () => { destroyed++; } });
  }, () => now);
  await assert.rejects(service.enqueue(task), {
    status: 409, code: 'ACTIVE_LOGIN_SESSION',
    message: '当前账号已有登录申请，请等待二维码过期或申请失败后重试。',
  });
  await service.enqueue({ ...task, id: '123e4567-e89b-42d3-a456-426614174001' });
  assert.equal(factories, 1);
  assert.equal(destroyed, 0);
});

test('业务错误不会被 Redis 通用 503 覆盖', async () => {
  const error = new ApiError(409, '已有登录申请', 'ACTIVE_LOGIN_SESSION');
  const service = new TaskService(config, () => driver({ eval: async () => { throw error; },
    destroy: () => assert.fail('business errors must not destroy the connection') }), () => now);
  await assert.rejects(service.enqueue(task), actual => actual === error);
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
    createdAt: task.createdAt, expiresAt: task.expiresAt, simulation: true, loginType: 'android_qq' });
  await assert.rejects(service.get(task.id, 'wrong-token'), { status: 404 });
  const missing = new TaskService(config, () => driver({ get: async () => null }), () => now);
  await assert.rejects(missing.get(task.id, task.accessToken), { status: 404 });
});

test('Cookie 身份只可读取自己的申请，响应不暴露内部字段', async () => {
  const service = new TaskService(config, () => driver({ get: async key => {
    assert.equal(key, `${config.redisQueueKey}:sessions:${task.id}`);
    return JSON.stringify({ ...stored, workerId: 'private-worker', privateInternalError: 'secret' });
  } }), () => now);
  assert.deepEqual(await service.getForUser(task.id, task.userId), { id: task.id, status: 'queued',
    createdAt: task.createdAt, expiresAt: task.expiresAt, simulation: true, loginType: 'android_qq' });
  await assert.rejects(service.getForUser(task.id, '456e7890-e89b-42d3-a456-426614174001'), { status: 404 });
  const missing = new TaskService(config, () => driver({ get: async () => null }), () => now);
  await assert.rejects(missing.getForUser(task.id, task.userId), { status: 404 });
  const legacy = new TaskService(config, () => driver({ get: async () => JSON.stringify({ ...stored, userId: undefined }) }), () => now);
  await assert.rejects(legacy.getForUser(task.id, task.userId), { status: 404 });
  const damagedOtherOwner = new TaskService(config, () => driver({ get: async () => JSON.stringify({ ...stored, tokenHash: 'bad' }) }), () => now);
  await assert.rejects(damagedOtherOwner.getForUser(task.id, 'other-user'), { status: 404 });
});

test('有效账号锁可恢复处理中及 qr_ready 申请，查询只读且不暴露内部信息', async () => {
  for (const status of ['queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready']) {
    const keys: string[] = [];
    const service = new TaskService(config, () => driver({ get: async key => {
      keys.push(key);
      return keys.length === 1 ? task.id : JSON.stringify({ ...stored, status, workerId: 'secret' });
    }, eval: async () => assert.fail('active lookup must not mutate locks') }), () => now);
    assert.deepEqual(await service.getActive(task.userId), { id: task.id, status,
      createdAt: task.createdAt, expiresAt: task.expiresAt, simulation: true, loginType: 'android_qq' });
    assert.deepEqual(keys, [`${config.redisQueueKey}:users:${task.userId}:active`, `${config.redisQueueKey}:sessions:${task.id}`]);
  }
});

test('失效、失败、丢失或不属于账号的 active 会话返回 null，不删除可能已更新的锁', async () => {
  const cases = [
    { lock: null, raw: null, at: now },
    { lock: task.id, raw: null, at: now },
    { lock: task.id, raw: JSON.stringify({ ...stored, status: 'failed' }), at: now },
    { lock: task.id, raw: JSON.stringify({ ...stored, status: 'expired' }), at: now },
    { lock: task.id, raw: JSON.stringify({ ...stored, status: 'qr_ready' }), at: now + 120000 },
    { lock: task.id, raw: JSON.stringify({ ...stored, userId: 'other-user' }), at: now },
  ];
  for (const scenario of cases) {
    let reads = 0;
    const service = new TaskService(config, () => driver({
      get: async () => ++reads === 1 ? scenario.lock : scenario.raw,
      eval: async () => assert.fail('stale lock cleanup must be atomic during enqueue'),
    }), () => scenario.at);
    assert.equal(await service.getActive(task.userId), null);
    assert.equal(reads, scenario.lock === null ? 1 : 2);
  }
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

test('工作进程失败仅按白名单代码返回安全中文，保留失败状态并忽略 Redis 任意错误文本', async () => {
  for (const errorCode of ['worker_clock_skew', 'invalid_task_payload', 'invalid_task_timestamps', 'constructor', 'private_secret', null]) {
    for (const at of [now, now + 120001]) {
      const service = new TaskService(config, () => driver({ get: async () => JSON.stringify({ ...stored,
        status: 'failed', errorCode, error: 'redis://private-password@private-host' }) }), () => at);
      const result = await service.getForUser(task.id, task.userId);
      assert.deepEqual(result, { id: task.id, status: 'failed', createdAt: task.createdAt, expiresAt: task.expiresAt,
        simulation: true, loginType: 'android_qq', ...loginFailure(errorCode) });
      assert.doesNotMatch(JSON.stringify(result), /private-password|private-host|private_secret|constructor/);
      await assert.rejects(service.getForUser(task.id, 'other-user'), { status: 404 });
    }
  }
  const pending = new TaskService(config, () => driver({ get: async () => JSON.stringify({ ...stored,
    errorCode: 'worker_clock_skew', error: 'secret' }) }), () => now);
  assert.equal(Object.hasOwn(await pending.getForUser(task.id, task.userId), 'errorCode'), false);
});
