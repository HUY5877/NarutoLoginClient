import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/server/config.js';
import type { RedisDriver } from '../src/server/queue.js';
import { QqGroupDiscoveryService } from '../src/server/qq-group-discovery.js';

const start = Date.parse('2026-10-26T12:00:00.000Z');
const config: Pick<Config, 'redisUrl' | 'redisQueueKey' | 'timeoutMs'> = { redisUrl: 'redis://fixture', redisQueueKey: 'fixture:test', timeoutMs: 100 };
type DiscoveryOptions = ConstructorParameters<typeof QqGroupDiscoveryService>[1];
function createService(options: DiscoveryOptions, overrides: Partial<typeof config> = {}) {
  return new QqGroupDiscoveryService({ ...config, ...overrides }, options);
}
function fixture() {
  let ready = false, connections = 0, destroyed = 0;
  let reply: unknown = 1;
  const calls: Array<{ script: string; keys: string[]; arguments: string[]; signal: AbortSignal }> = [];
  const driver: RedisDriver = {
    get isReady() { return ready; },
    async connect() { connections++; ready = true; },
    async eval(script, options, signal) { calls.push({ script, ...options, signal }); return reply; },
    async get() { assert.fail('群发现必须使用单次原子脚本'); },
    destroy() { destroyed++; ready = false; },
  };
  return { driver, calls, setReply(value: unknown) { reply = value; },
    get connections() { return connections; }, get destroyed() { return destroyed; } };
}

test('群发现只把当前应用的群标识写入独立有界集合并设置十分钟过期', async () => {
  const f = fixture();
  const service = await createService({ createDriver: () => f.driver, now: () => start });
  try {
    await service.record('11111111', 'group-fixture');
    assert.equal(f.connections, 1);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.deepEqual(call.keys, ['fixture:test:qq:observed-groups:11111111']);
    assert.deepEqual(call.arguments, ['1793016000000', '1793015400000', 'group-fixture', '20', '600']);
    assert.match(call.script, /redis\.call\('ZREMRANGEBYSCORE', KEYS\[1\], '-inf', ARGV\[2\]\)/);
    assert.match(call.script, /redis\.call\('ZADD', KEYS\[1\], ARGV\[1\], ARGV\[3\]\)/);
    assert.match(call.script, /redis\.call\('ZREMRANGEBYRANK', KEYS\[1\], 0, -tonumber\(ARGV\[4\]\) - 1\)/);
    assert.match(call.script, /redis\.call\('EXPIRE', KEYS\[1\], ARGV\[5\]\)/);
    assert.doesNotMatch(call.script, /LPUSH|XADD|PUBLISH|member_openid|content|username/);
    assert.equal(call.signal.aborted, false);
  } finally { await service.close(); }
});

test('群发现只读最近十分钟至多二十项并返回时间，不续期或暴露其他数据', async () => {
  const f = fixture();
  f.setReply(['latest-group', '1793016000000', 'earlier-group', '1793015999000']);
  const service = await createService({ createDriver: () => f.driver, now: () => start });
  try {
    assert.deepEqual(await service.list('11111111'), [
      { groupOpenid: 'latest-group', seenAt: '2026-10-26T12:00:00.000Z' },
      { groupOpenid: 'earlier-group', seenAt: '2026-10-26T11:59:59.000Z' },
    ]);
    const call = f.calls[0];
    assert.deepEqual(call.keys, ['fixture:test:qq:observed-groups:11111111']);
    assert.deepEqual(call.arguments, ['1793016000000', '1793015400000', '20']);
    assert.match(call.script, /redis\.call\('ZREVRANGEBYSCORE', KEYS\[1\], ARGV\[1\], '\(' \.\. ARGV\[2\], 'WITHSCORES', 'LIMIT', 0, ARGV\[3\]\)/);
    assert.doesNotMatch(call.script, /EXPIRE|ZADD|ZREM|SET|DEL/);
    f.setReply([]);
    assert.deepEqual(await service.list('22222222'), []);
    assert.deepEqual(f.calls[1].keys, ['fixture:test:qq:observed-groups:22222222']);
    assert.equal(f.connections, 1);
  } finally { await service.close(); }
});

test('无效机器人和群标识在创建连接前拒绝，接受一百二十八字符群标识', async () => {
  let created = 0;
  const f = fixture();
  const service = await createService({ createDriver: () => { created++; return f.driver; }, now: () => start });
  try {
    for (const appId of ['', 'bad', '1:2', '1'.repeat(33)]) {
      await assert.rejects(service.record(appId, 'group'), { status: 400 });
      await assert.rejects(service.list(appId), { status: 400 });
    }
    for (const group of ['', 'group:other', 'group/openid', 'a'.repeat(129)]) {
      await assert.rejects(service.record('11111111', group), { status: 400 });
    }
    assert.equal(created, 0); assert.equal(f.calls.length, 0);
    await service.record('1', 'a'.repeat(128));
    assert.equal(created, 1);
  } finally { await service.close(); }
});

test('缺少 Redis 配置时明确报错，不建立连接', async () => {
  const service = await createService({ createDriver: () => assert.fail('无配置不应创建连接') }, { redisUrl: undefined });
  await assert.rejects(service.record('1', 'group'), { status: 503, code: 'REDIS_NOT_CONFIGURED' });
  await assert.rejects(service.list('1'), { status: 503, code: 'REDIS_NOT_CONFIGURED' });
  await service.close();
});

test('并发群发现复用尚未完成的连接，关闭时释放一次', async () => {
  const f = fixture(); let release!: () => void, connects = 0;
  f.driver.connect = async () => { connects++; await new Promise<void>(resolve => { release = resolve; }); };
  const service = await createService({ createDriver: () => f.driver, now: () => start });
  const first = service.record('1', 'group-a'), second = service.record('1', 'group-b');
  assert.equal(connects, 1);
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.length, 2);
  await service.close(); await service.close();
  assert.equal(f.destroyed, 1);
});

test('Redis 驱动失败脱敏，销毁旧连接后下次读取重建', async () => {
  const broken = fixture(), recovered = fixture(); let created = 0;
  broken.driver.eval = async () => { throw new Error('redis://private:password@private-host'); };
  recovered.setReply([]);
  const service = await createService({ createDriver: () => ++created === 1 ? broken.driver : recovered.driver, now: () => start });
  try {
    await assert.rejects(service.record('1', 'group'), error => {
      assert.equal((error as { status: number }).status, 503);
      assert.equal((error as { code: string }).code, 'REDIS_UNAVAILABLE');
      assert.doesNotMatch(String(error), /private|password|redis:\/\//); return true;
    });
    assert.equal(broken.destroyed, 1);
    assert.deepEqual(await service.list('1'), []);
    assert.equal(created, 2);
  } finally { await service.close(); }
});

test('连接失败不执行命令，销毁连接并允许下次重新连接', async () => {
  const broken = fixture(), recovered = fixture(); let created = 0;
  broken.driver.connect = async () => { throw new Error('redis://private:password@private-host'); };
  recovered.setReply([]);
  const service = createService({ createDriver: () => ++created === 1 ? broken.driver : recovered.driver, now: () => start });
  try {
    await assert.rejects(service.list('1'), error => {
      assert.equal((error as { status: number }).status, 503);
      assert.doesNotMatch(String(error), /private|password|redis:\/\//); return true;
    });
    assert.equal(broken.calls.length, 0); assert.equal(broken.destroyed, 1);
    assert.deepEqual(await service.list('1'), []); assert.equal(recovered.connections, 1);
  } finally { await service.close(); }
});

test('群发现超时中止命令并清理连接，清理异常不泄露驱动信息', async () => {
  const f = fixture(); let commandSignal: AbortSignal | undefined, destroyed = 0;
  f.driver.eval = async (_script, _options, signal) => { commandSignal = signal; return new Promise(() => {}); };
  f.driver.destroy = () => { destroyed++; throw new Error('private destroy diagnostics'); };
  const service = await createService({ createDriver: () => f.driver, now: () => start }, { timeoutMs: 10 });
  await assert.rejects(service.record('1', 'group'), error => {
    assert.equal((error as { status: number }).status, 503);
    assert.doesNotMatch(String(error), /private|diagnostics/); return true;
  });
  assert.equal(commandSignal?.aborted, true); assert.equal(destroyed, 1);
  await service.close();
});

test('连接超时后即使迟到连接完成也不能补写群标识', async () => {
  const f = fixture(); let release!: () => void;
  f.driver.connect = async () => new Promise<void>(resolve => { release = resolve; });
  const service = createService({ createDriver: () => f.driver, now: () => start }, { timeoutMs: 10 });
  await assert.rejects(service.record('1', 'group'), { status: 503, code: 'REDIS_UNAVAILABLE' });
  assert.equal(f.destroyed, 1);
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
  await service.close();
});

test('关闭时吞掉清理异常且丢弃连接，重复关闭没有额外清理', async () => {
  const f = fixture(); let destroyed = 0;
  f.driver.destroy = () => { destroyed++; throw new Error('private cleanup diagnostics'); };
  const service = createService({ createDriver: () => f.driver, now: () => start });
  await service.record('1', 'group');
  await service.close(); await service.close();
  assert.equal(destroyed, 1);
});

test('畸形或过期 Redis 结果不能暴露为候选群，超量返回也被拒绝', async () => {
  for (const reply of [null, ['group'], ['bad:group', String(start)], ['group', 'private-secret'],
    ['group', String(start - 600000)], ['group', String(start + 1)], Array(42).fill('group')]) {
    const f = fixture(); f.setReply(reply);
    const service = await createService({ createDriver: () => f.driver, now: () => start });
    try { await assert.rejects(service.list('1'), error => {
      assert.equal((error as { status: number }).status, 503);
      assert.doesNotMatch(String(error), /private-secret|bad:group/); return true;
    }); } finally { await service.close(); }
  }
});
