import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { ModelChannelService } from '../src/server/model-channels.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';

const env = { APP_ENV: 'test', CLOUDFLARE_API_TOKEN: 'private-cloudflare-fixture',
  CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_KV_NAMESPACE_ID_PROD: 'prod-space', CLOUDFLARE_KV_NAMESPACE_ID_TEST: 'test-space' };
const admin = { id: 'administrator', username: '管理员', isAdmin: true };
const secret = 'private-deepseek-key';
const errorIs = (status: number, code?: string) => (error: unknown) => {
  assert(error instanceof ApiError); assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /private-|Bearer|api\.cloudflare/); return true;
};
function fixture(values: Record<string, string | null> = {}) {
  const state = { values: { DEEPSEEK_API_KEY: secret, DEEPSEEK_MODEL: 'deepseek-chat', ...values } as Record<string, string | null>,
    calls: [] as Array<{ url: URL; init: RequestInit }>, failWrite: false, omitMissing: false,
    upstream: async (): Promise<Response> => Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }) };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); state.calls.push({ url, init });
    if (url.hostname !== 'api.cloudflare.com') return state.upstream();
    if (url.pathname.endsWith('/bulk/get')) {
      const body = JSON.parse(String(init.body));
      return Response.json({ success: true, result: { values: Object.fromEntries(body.keys.flatMap((key: string) =>
        state.omitMissing && !(key in state.values) ? [] : [[key, state.values[key] ?? null]])) } });
    }
    if (state.failWrite) return Response.json({ success: false, errors: [{ message: 'private-provider-error' }] }, { status: 403 });
    assert.equal(url.pathname.endsWith('/bulk'), true);
    for (const { key, value } of JSON.parse(String(init.body))) state.values[key as keyof typeof state.values] = value;
    return Response.json({ success: true, result: { successful_key_count: 3 } });
  };
  return { state, fetcher, service: new ModelChannelService({ env, fetch: fetcher, timeoutMs: 50 }) };
}
async function readChannel(service: ModelChannelService, id = 'deepseek') {
  return (await service.list(admin)).channels.find(channel => channel.id === id)!;
}

test('渠道列表只读取当前 namespace 并脱敏旧单 key 和列表', async () => {
  const f = fixture({ OPENAI_API_KEY: '["private-one","private-two"]', OPENAI_MODEL: 'vision', OPENAI_ENABLED: 'false' });
  const result = await f.service.list(admin);
  assert.equal(result.environment, 'test'); assert.equal(result.channels.length, 2);
  const deepseek = result.channels.find(channel => channel.id === 'deepseek')!;
  assert.equal(deepseek.enabled, true); assert.equal(deepseek.model, 'deepseek-chat'); assert.equal(deepseek.keys.length, 1);
  assert.equal(result.channels.find(channel => channel.id === 'openai')!.enabled, false);
  assert.equal(result.channels.find(channel => channel.id === 'openai')!.keys.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-|cloudflare-fixture/);
  assert(f.state.calls.every(call => call.url.pathname.includes('/namespaces/test-space/')));
});

test('Cloudflare 残留鱼玩配置不会被读取、显示或随其他渠道保存修改', async () => {
  const leftover = { YUWAN_API_KEY: '["private-legacy-broken"', YUWAN_MODEL: 'private-yuwan-model', YUWAN_ENABLED: 'true' };
  const f = fixture(leftover);
  const result = await f.service.list(admin);
  assert.deepEqual(result.channels.map(channel => channel.id), ['openai', 'deepseek']);
  assert.doesNotMatch(JSON.stringify(result), /yuwan|鱼玩|private-legacy/);
  assert.deepEqual(JSON.parse(String(f.state.calls[0].init.body)).keys,
    ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_ENABLED', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_ENABLED']);
  const channel = result.channels.find(channel => channel.id === 'deepseek')!;
  await f.service.update(admin, 'deepseek', { version: channel.version, model: channel.model, enabled: channel.enabled,
    keys: channel.keys.map(({ id }) => ({ id })) });
  assert.deepEqual({ YUWAN_API_KEY: f.state.values.YUWAN_API_KEY, YUWAN_MODEL: f.state.values.YUWAN_MODEL,
    YUWAN_ENABLED: f.state.values.YUWAN_ENABLED }, leftover);
  for (const call of f.state.calls) assert.doesNotMatch(String(call.init.body), /YUWAN_/);
});

test('管理员直接调用鱼玩保存或测试接口时在访问任何远端服务前拒绝', async () => {
  const f = fixture();
  await assert.rejects(f.service.update(admin, 'yuwan', { version: 'a'.repeat(43), model: 'local-only-model', enabled: true,
    keys: [{ value: 'private-local-only' }] }), errorIs(400, 'MODEL_CHANNEL_INVALID'));
  assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.service.test(admin, 'yuwan', { model: 'local-only-model', key: { value: 'private-local-only' } }), errorIs(400, 'MODEL_CHANNEL_INVALID'));
  assert.equal(f.state.calls.length, 0);
});

test('全部渠道未配置时兼容 KV 返回 null 或省略字段，读取不创建空配置', async () => {
  for (const omitMissing of [false, true]) {
    const f = fixture(); f.state.values = {}; f.state.omitMissing = omitMissing;
    const result = await f.service.list(admin);
    assert.equal(result.environment, 'test');
    assert.deepEqual(result.channels.map(channel => channel.id), ['openai', 'deepseek']);
    for (const channel of result.channels) {
      assert.equal(channel.model, ''); assert.equal(channel.enabled, false); assert.deepEqual(channel.keys, []);
      assert.equal(channel.configurationError, undefined); assert.match(channel.version, /^[A-Za-z0-9_-]{43}$/);
    }
    assert.deepEqual(f.state.values, {});
    assert.equal(f.state.calls.some(call => call.init.method === 'PUT'), false);
  }
});

test('首次保存缺失渠道时一次 upsert 创建三个完整字段，不预写空值或修改其他渠道', async () => {
  for (const [id, prefix] of [['openai', 'OPENAI'], ['deepseek', 'DEEPSEEK']] as const) {
    const f = fixture(); f.state.values = { JEV_MODEL: 'unchanged-judge', REDIS_QUEUE_KEY: 'unchanged-queue' };
    f.state.omitMissing = true;
    const channel = await readChannel(f.service, id);
    const saved = await f.service.update(admin, id, { version: channel.version, model: 'created-model', enabled: true,
      keys: [{ value: 'private-created-one' }, { value: 'private-created-two' }] });
    const expected = { [`${prefix}_API_KEY`]: '["private-created-one","private-created-two"]',
      [`${prefix}_MODEL`]: 'created-model', [`${prefix}_ENABLED`]: 'true' };
    assert.deepEqual(f.state.values, { JEV_MODEL: 'unchanged-judge', REDIS_QUEUE_KEY: 'unchanged-queue', ...expected });
    const writes = f.state.calls.filter(call => call.init.method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url.pathname, '/client/v4/accounts/account/storage/kv/namespaces/test-space/bulk');
    assert.deepEqual(JSON.parse(String(writes[0].init.body)), Object.entries(expected).map(([key, value]) => ({ key, value })));
    assert.equal(saved.keys.length, 2); assert.equal(saved.enabled, true); assert.notEqual(saved.version, channel.version);
    assert.deepEqual(await readChannel(f.service, id), saved);
    assert.doesNotMatch(JSON.stringify(saved), /private-/);
  }
});

test('部分字段缺失时保存补齐字段并保留旧 key，重复保存不丢失或替换 key', async () => {
  const profiles: Array<{ values: Record<string, string>; model: string; oldKeys: string[] }> = [
    { values: { DEEPSEEK_MODEL: 'existing-model', DEEPSEEK_ENABLED: 'true' }, model: 'existing-model', oldKeys: [] },
    { values: { DEEPSEEK_API_KEY: 'private-existing', DEEPSEEK_ENABLED: 'true' }, model: '', oldKeys: ['private-existing'] },
    { values: { DEEPSEEK_API_KEY: '["private-one","private-two"]', DEEPSEEK_MODEL: 'existing-model' }, model: 'existing-model', oldKeys: ['private-one', 'private-two'] },
  ];
  for (const profile of profiles) {
    const f = fixture(); f.state.values = { ...profile.values }; f.state.omitMissing = true;
    const channel = await readChannel(f.service);
    assert.equal(channel.model, profile.model); assert.equal(channel.keys.length, profile.oldKeys.length);
    const saved = await f.service.update(admin, 'deepseek', { version: channel.version, model: channel.model || 'created-model', enabled: true,
      keys: channel.keys.length ? channel.keys.map(({ id }) => ({ id })) : [{ value: 'private-new' }] });
    const expected = { DEEPSEEK_API_KEY: JSON.stringify(profile.oldKeys.length ? profile.oldKeys : ['private-new']),
      DEEPSEEK_MODEL: profile.model || 'created-model', DEEPSEEK_ENABLED: 'true' };
    assert.deepEqual(f.state.values, expected);
    assert.equal(f.state.calls.filter(call => call.init.method === 'PUT').length, 1);
    const repeated = await f.service.update(admin, 'deepseek', { version: saved.version, model: saved.model, enabled: saved.enabled,
      keys: saved.keys.map(({ id }) => ({ id })) });
    assert.deepEqual(f.state.values, expected); assert.deepEqual(repeated, saved);
    assert.equal(f.state.calls.filter(call => call.init.method === 'PUT').length, 2);
  }
});

test('缺失渠道保存前的读取失败不能当作空配置并继续写入', async () => {
  for (const failure of [
    async (): Promise<Response> => { throw new Error('private-read-network'); },
    async () => Response.json({ success: false }, { status: 403 }),
    async () => Response.json({ success: false, errors: [{ message: 'private-read-error' }] }),
    async () => Response.json({ success: true, result: {} }),
  ]) {
    const f = fixture(); f.state.values = {};
    const channel = await readChannel(f.service, 'openai');
    let writes = 0;
    const service = new ModelChannelService({ env, fetch: async (_input, init) => {
      if (init?.method === 'PUT') writes++;
      return failure();
    } });
    await assert.rejects(service.update(admin, 'openai', { version: channel.version, model: 'new-model', enabled: true,
      keys: [{ value: 'private-created' }] }), errorIs(503, 'MODEL_CHANNEL_READ_FAILED'));
    assert.equal(writes, 0); assert.deepEqual(f.state.values, {});
  }
});

test('首次创建遇到写入错误或部分成功时不能返回保存成功，也不能预写空字段', async () => {
  for (const failure of [
    async (): Promise<Response> => { throw new Error('private-write-network'); },
    async () => Response.json({ success: false }, { status: 403 }),
    async () => Response.json({ success: false, errors: [{ message: 'private-write-error' }] }),
    async () => Response.json({ success: true, result: { successful_key_count: 2 } }),
  ]) {
    const f = fixture(); f.state.values = {};
    const channel = await readChannel(f.service, 'openai');
    const writes: unknown[] = [];
    const service = new ModelChannelService({ env, fetch: async (input, init) => {
      if (init?.method !== 'PUT') return f.fetcher(input, init);
      writes.push(JSON.parse(String(init.body)));
      return failure();
    } });
    await assert.rejects(service.update(admin, 'openai', { version: channel.version, model: 'new-model', enabled: true,
      keys: [{ value: 'private-created' }] }), errorIs(503, 'MODEL_CHANNEL_SAVE_FAILED'));
    assert.deepEqual(writes, [[{ key: 'OPENAI_API_KEY', value: '["private-created"]' },
      { key: 'OPENAI_MODEL', value: 'new-model' }, { key: 'OPENAI_ENABLED', value: 'true' }]]);
    assert.deepEqual(f.state.values, {});
  }
});

test('保存保留原 key、添加新 key 和删除未选 key，返回更新的脱敏 ID', async () => {
  const f = fixture({ DEEPSEEK_API_KEY: '["private-old-one","private-old-two"]' });
  const old = (await f.service.list(admin)).channels.find(channel => channel.id === 'deepseek')!;
  const result = await f.service.update(admin, 'deepseek', { version: old.version, model: 'new-model', enabled: true, keys: [{ id: old.keys[1].id }, { value: 'private-new' }] });
  assert.equal(result.model, 'new-model'); assert.equal(result.keys.length, 2);
  assert.deepEqual(JSON.parse(f.state.values.DEEPSEEK_API_KEY!), ['private-old-two', 'private-new']);
  assert.equal(f.state.values.DEEPSEEK_ENABLED, 'true');
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.notEqual(result.keys[0].id, old.keys[1].id);
  await assert.rejects(f.service.update(admin, 'deepseek', { version: old.version, model: 'old', enabled: true, keys: [{ id: old.keys[1].id }] }), errorIs(409, 'MODEL_CHANNEL_CHANGED'));
  await assert.rejects(f.service.update(admin, 'openai', { version: (await readChannel(f.service, 'openai')).version, model: 'vision', enabled: true, keys: [{ id: result.keys[0].id }] }), errorIs(409));
});

test('key JSON 损坏时标记本渠道错误，不能把 JSON 当作单 key 或阻断其他渠道', async () => {
  for (const raw of ['["broken"', '{"key":"private-x"}', '[null]', '[""]', '["private-x\\n"]', 'null', 'true', '123', 'private-key\n']) {
    const f = fixture({ DEEPSEEK_API_KEY: raw });
    const channels = (await f.service.list(admin)).channels;
    const damaged = channels.find(channel => channel.id === 'deepseek')!;
    assert.equal(damaged.keys.length, 0); assert(damaged.configurationError);
    assert(channels.filter(channel => channel.id !== 'deepseek').every(channel => !channel.configurationError));
    assert.doesNotMatch(JSON.stringify(channels), /private-/);
    assert.equal(f.state.calls.filter(call => call.init.method === 'PUT').length, 0);
  }
});

test('限制渠道、model、key 数量、字符与控制字符，禁用允许空 key', async () => {
  const f = fixture();
  const version = (await readChannel(f.service)).version;
  for (const body of [
    { model: 'x', enabled: true, keys: [] }, { model: '', enabled: true, keys: [{ value: 'x' }] },
    { model: 'x'.repeat(201), enabled: false, keys: [] }, { model: 'x\n', enabled: false, keys: [] },
    { model: 'x', enabled: true, keys: [{ value: 'x'.repeat(513) }] },
    { model: 'x', enabled: true, keys: [{ value: '密'.repeat(513) }] },
    { model: 'x', enabled: true, keys: [{ value: 'x\n' }] },
    { model: 'x', enabled: true, keys: Array.from({ length: 21 }, () => ({ value: 'x' })) },
    { model: 'x', enabled: true, keys: [{ id: 'unknown', value: 'x' }] },
    { model: 'x', enabled: true, keys: [{ value: 'x' }], namespace: 'prod-space' },
  ]) await assert.rejects(f.service.update(admin, 'deepseek', { ...body, version }), errorIs(400));
  await assert.rejects(f.service.update(admin, 'jev', { model: '', enabled: false, keys: [] }), errorIs(400));
  for (const bad of [undefined, '', 'forged']) await assert.rejects(f.service.update(admin, 'deepseek', { version: bad, model: '', enabled: false, keys: [] }), errorIs(400));
  const disabled = await f.service.update(admin, 'deepseek', { version, model: '', enabled: false, keys: [] });
  assert.equal(disabled.enabled, false); assert.equal(f.state.values.DEEPSEEK_API_KEY, '[]');
});

test('和 worker 一致按 Unicode 字符校验上限，启停字段空值不默认为启用', async () => {
  const f = fixture();
  const saved = await f.service.update(admin, 'deepseek', { version: (await readChannel(f.service)).version, model: ` ${'模'.repeat(200)} `, enabled: true,
    keys: [{ value: ` ${'🔑'.repeat(512)} ` }] });
  assert.equal(saved.keys.length, 1); assert.equal(saved.model, '模'.repeat(200));
  assert.deepEqual(JSON.parse(f.state.values.DEEPSEEK_API_KEY!), ['🔑'.repeat(512)]);
  for (const enabled of ['', ' ', '1', 'TRUE']) {
    const invalid = await readChannel(fixture({ DEEPSEEK_ENABLED: enabled }).service);
    assert.equal(invalid.enabled, false); assert(invalid.configurationError);
  }
});

test('当前配置外部变化后旧 key ID 被拒绝，KV 写失败不能返回保存成功', async () => {
  const f = fixture(); const channel = (await f.service.list(admin)).channels.find(channel => channel.id === 'deepseek')!;
  f.state.values.DEEPSEEK_API_KEY = 'private-replaced';
  await assert.rejects(f.service.update(admin, 'deepseek', { version: channel.version, model: 'x', enabled: true, keys: [{ id: channel.keys[0].id }] }), errorIs(409));
  f.state.failWrite = true;
  await assert.rejects(f.service.update(admin, 'deepseek', { version: (await readChannel(f.service)).version, model: 'x', enabled: true, keys: [{ value: 'private-new' }] }), errorIs(503, 'MODEL_CHANNEL_SAVE_FAILED'));
  assert.equal(f.state.values.DEEPSEEK_API_KEY, 'private-replaced');
});

test('两个管理员先后编辑时全删与全替换都必须检查版本，刷新后才能保存', async () => {
  for (const keys of [[], [{ value: 'private-admin-a-new' }]]) {
    const f = fixture();
    const secondService = new ModelChannelService({ env, fetch: f.fetcher });
    const a = await readChannel(f.service), b = await readChannel(secondService);
    assert.match(a.version, /^[A-Za-z0-9_-]{43}$/); assert.equal(a.version, b.version);
    const bSaved = await secondService.update(admin, 'deepseek', { version: b.version, model: 'b-model', enabled: true, keys: [{ value: 'private-admin-b' }] });
    assert.notEqual(bSaved.version, a.version);
    const writesBefore = f.state.calls.filter(call => call.init.method === 'PUT').length;
    await assert.rejects(f.service.update(admin, 'deepseek', { version: a.version, model: 'a-model', enabled: keys.length > 0, keys }), errorIs(409, 'MODEL_CHANNEL_CHANGED'));
    assert.equal(f.state.calls.filter(call => call.init.method === 'PUT').length, writesBefore);
    assert.equal(f.state.values.DEEPSEEK_MODEL, 'b-model');
    assert.deepEqual(JSON.parse(f.state.values.DEEPSEEK_API_KEY!), ['private-admin-b']);
    const refreshed = await readChannel(f.service);
    const saved = await f.service.update(admin, 'deepseek', { version: refreshed.version, model: 'a-model', enabled: keys.length > 0, keys });
    assert.equal(saved.keys.length, keys.length); assert.notEqual(saved.version, refreshed.version);
    assert.equal(saved.configurationError, undefined);
  }
});

test('关闭渠道的坏 JSON 和非法模型开关可单渠道展示并清空或替换修复', async () => {
  const damagedProfiles: Array<Record<string, string>> = [
    { DEEPSEEK_API_KEY: '["private-broken"', DEEPSEEK_ENABLED: 'false' },
    { DEEPSEEK_MODEL: 'private-model\n', DEEPSEEK_ENABLED: 'invalid' },
  ];
  for (const bad of damagedProfiles) {
    const f = fixture(bad);
    const channel = await readChannel(f.service);
    assert(channel.configurationError); assert.match(channel.version, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(channel.enabled, false);
    if ('DEEPSEEK_MODEL' in bad) { assert.equal(channel.model, ''); assert.equal(channel.keys.length, 1); }
    else assert.deepEqual(channel.keys, []);
    assert.doesNotMatch(JSON.stringify(channel), /private-/);
    const repaired = await f.service.update(admin, 'deepseek', { version: channel.version, model: '', enabled: false, keys: [] });
    assert.equal(repaired.configurationError, undefined);
    assert.equal((await readChannel(f.service)).configurationError, undefined);
    assert.equal(f.state.values.DEEPSEEK_API_KEY, '[]');
    const replacement = await f.service.update(admin, 'deepseek', { version: repaired.version, model: 'repaired-model', enabled: true, keys: [{ value: 'private-repaired' }] });
    assert.equal(replacement.keys.length, 1); assert.equal(replacement.enabled, true);
  }
});

test('网络错误与非文本 KV 值仍拒绝整个读取，不能冒充空配置', async () => {
  for (const fetcher of [
    async () => { throw new Error('private-network'); },
    async () => Response.json({ success: true, result: { values: { OPENAI_API_KEY: ['private-invalid-type'] } } }),
  ]) await assert.rejects(new ModelChannelService({ env, fetch: fetcher }).list(admin), errorIs(503, 'MODEL_CHANNEL_READ_FAILED'));
});

test('正式兼容旧 namespace，测试配置缺失和共用 namespace 均不发请求', async () => {
  const f = fixture();
  const prod = new ModelChannelService({ env: { APP_ENV: 'prod', CLOUDFLARE_API_TOKEN: 'fixture', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_KV_NAMESPACE_ID: 'legacy' }, fetch: f.fetcher });
  assert.equal((await prod.list(admin)).environment, 'prod');
  assert(f.state.calls.every(call => call.url.pathname.includes('/namespaces/legacy/')));
  for (const bad of [{ ...env, CLOUDFLARE_KV_NAMESPACE_ID_TEST: '' }, { ...env, CLOUDFLARE_KV_NAMESPACE_ID_TEST: 'prod-space' }]) {
    const service = new ModelChannelService({ env: bad, fetch: async () => assert.fail('不允许请求正式配置') });
    await assert.rejects(service.list(admin), errorIs(503));
  }
});

test('服务本身拒绝普通用户读取、修改或测试模型', async () => {
  const f = fixture(); const user = { ...admin, isAdmin: false };
  await assert.rejects(f.service.list(user), errorIs(403));
  await assert.rejects(f.service.update(user, 'openai', {}), errorIs(403));
  await assert.rejects(f.service.test(user, 'openai', {}), errorIs(403));
  assert.equal(f.state.calls.length, 0);
});

test('连接测试使用固定 URL 和指定未保存模型，不写 KV，不回显模型内容', async () => {
  const f = fixture();
  const result = await f.service.test(admin, 'openai', { model: 'chosen-model', key: { value: 'private-unsaved' } });
  assert.equal(result.ok, true); assert(result.latencyMs >= 0);
  assert.doesNotMatch(JSON.stringify(result), /private-|chosen-model/);
  assert.equal(f.state.calls.length, 1);
  const call = f.state.calls[0]; assert.equal(String(call.url), 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.redirect, 'error');
  assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer private-unsaved');
  assert.equal(JSON.parse(String(call.init.body)).model, 'chosen-model');
});

test('测试已保存 key 只读取当前配置且不移动轮询计数器', async () => {
  const f = fixture(); const channel = (await f.service.list(admin)).channels.find(channel => channel.id === 'deepseek')!;
  f.state.calls.length = 0;
  assert.equal((await f.service.test(admin, 'deepseek', { model: 'unsaved-model', key: { id: channel.keys[0].id } })).ok, true);
  assert.equal(f.state.calls.length, 2);
  assert.equal(String(f.state.calls[1].url), 'https://api.deepseek.com/chat/completions');
  assert.equal((f.state.calls[1].init.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
  assert.equal(f.state.calls.some(call => call.init.method === 'PUT'), false);
});

test('HTTP 错误、伪成功、重定向、网络异常和超时均返回安全失败', async () => {
  for (const upstream of [
    async () => Response.json({ error: 'private-upstream-error' }, { status: 401 }),
    async () => Response.json({ error: 'private-upstream-error' }, { status: 429 }),
    async () => Response.json({ status: 'ok' }),
    async () => Response.json({ choices: [{ message: { role: 'assistant', content: '' } }] }),
    async () => new Response('private-redirect', { status: 302, headers: { Location: 'https://example.invalid' } }),
    async () => { throw new Error('private-network-token'); },
    async (): Promise<Response> => new Promise(() => {}),
  ]) {
    const f = fixture(); f.state.upstream = upstream;
    const result = await f.service.test(admin, 'deepseek', { model: 'x', key: { value: 'private-key' } });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('推理模型完成令牌达到上限时仍确认连接，伪造或空 usage 不算成功', async () => {
  const completion = { id: 'completion-fixture', object: 'chat.completion', model: 'reasoning-model',
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    usage: { prompt_tokens: 8, completion_tokens: 256, total_tokens: 264 } };
  for (const id of ['openai', 'deepseek']) {
    const f = fixture(); f.state.upstream = async () => Response.json(completion);
    const result = await f.service.test(admin, id, { model: 'reasoning-model', key: { value: 'private-key' } });
    assert.equal(result.ok, true); assert.match(result.message, /上限/);
  }
  for (const malformed of [
    { ...completion, object: 'status' }, { ...completion, id: '' }, { ...completion, model: '' },
    { ...completion, usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 } },
    { ...completion, usage: { prompt_tokens: 8, completion_tokens: 256, total_tokens: 8 } },
    { ...completion, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] },
  ]) {
    const f = fixture(); f.state.upstream = async () => Response.json(malformed);
    assert.equal((await f.service.test(admin, 'openai', { model: 'x', key: { value: 'private-key' } })).ok, false);
  }
});

test('模型路由保护所有方法，拒绝跨站请求，支持受限的多 key 请求体', async () => {
  const f = fixture();
  const unexpected = async (): Promise<never> => assert.fail('无关服务不应被调用');
  const app = createApp(loadConfig({}), { modelChannels: f.service,
    auth: { getUser: async token => token === 'header.admin.signature' ? admin : token === 'header.user.signature' ? { ...admin, isAdmin: false } : null,
      register: unexpected, login: unexpected, listApplications: unexpected, reviewApplication: unexpected },
    storage: { read: unexpected, exists: unexpected }, events: { create: unexpected, getForUser: unexpected, getActive: unexpected, recordStatus: unexpected } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [method, suffix, body] of [['GET', '', undefined], ['PUT', '/deepseek', {}], ['POST', '/deepseek/test', {}]] as const) {
      for (const [cookie, status] of [['', 401], ['naruto_session=header.user.signature', 403]] as const) {
        const response = await fetch(`${base}/api/admin/model-channels${suffix}`, { method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal(response.status, status);
      }
    }
    assert.equal(f.state.calls.length, 0);
    const headers = { Cookie: 'naruto_session=header.admin.signature', 'Content-Type': 'application/json' };
    for (const [method, path, body] of [
      ['PUT', '/yuwan', { version: 'a'.repeat(43), model: 'local-only-model', enabled: true, keys: [{ value: 'private-local-only' }] }],
      ['POST', '/yuwan/test', { model: 'local-only-model', key: { value: 'private-local-only' } }],
    ] as const) {
      const response = await fetch(`${base}/api/admin/model-channels${path}`, { method, headers, body: JSON.stringify(body) });
      assert.equal(response.status, 400); assert.equal((await response.json()).code, 'MODEL_CHANNEL_INVALID');
      assert.equal(f.state.calls.length, 0);
    }
    const blocked = await fetch(`${base}/api/admin/model-channels/deepseek`, { method: 'PUT', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' });
    assert.equal(blocked.status, 403);
    const body = { version: (await readChannel(f.service)).version, model: 'x', enabled: true, keys: Array.from({ length: 20 }, (_, i) => ({ value: `key-${i}-${'x'.repeat(400)}` })) };
    const saved = await fetch(`${base}/api/admin/model-channels/deepseek`, { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).keys.length, 20);
    const huge = await fetch(`${base}/api/admin/model-channels/deepseek`, { method: 'PUT', headers, body: JSON.stringify({ extra: 'x'.repeat(40_000) }) });
    assert.equal(huge.status, 400);
  } finally { server.close(); await once(server, 'close'); }
});
