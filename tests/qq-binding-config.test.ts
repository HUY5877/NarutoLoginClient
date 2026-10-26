import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadConfig } from '../src/server/config.js';
import { createRuntimeConfigLoader } from '../src/server/cloudflare.js';
import { cloudflareTestEnv } from './cloudflare-fixture.js';

const bot = { QQ_BOT_APP_ID: '11111111', QQ_BOT_APP_SECRET: 'fixture-secret', QQ_BOT_GROUP_OPENID: 'group-fixture' };

test('机器人配置必须三项同配，全部留空时关闭绑定功能', () => {
  assert.throws(() => loadConfig({ QQ_BOT_APP_ID: bot.QQ_BOT_APP_ID }), /QQ_BOT/);
  assert.throws(() => loadConfig({ ...bot, QQ_BOT_GROUP_OPENID: ' ' }), /QQ_BOT/);
  assert.deepEqual(loadConfig(bot).qqBot, { appId: '11111111', appSecret: 'fixture-secret', groupOpenid: 'group-fixture' });
  assert.equal(loadConfig({}).qqBot, undefined);
});

test('机器人三项配置只从当前 Cloudflare namespace 读取', async () => {
  const calls: URL[] = [];
  const values = { PORT: '4300', SESSION_COOKIE_NAME: 'fixture', STORAGE_DRIVER: 'local', LOCAL_OBJECTS_DIR: 'fixture',
    REDIS_QUEUE_KEY: 'fixture', OSS_KEY_PREFIX: 'fixture', ...bot };
  const loader = createRuntimeConfigLoader({ env: { ...cloudflareTestEnv, APP_ENV: 'test', ...bot, QQ_BOT_APP_SECRET: 'stale-secret' },
    fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      if (url.pathname.endsWith('/keys')) return Response.json({ success: true, result: Object.keys(values).map(name => ({ name })) });
      const keys = JSON.parse(String(init?.body)).keys as Array<keyof typeof values>;
      return Response.json({ success: true, result: { values: Object.fromEntries(keys.map(key => [key, values[key]])) } });
    } });
  assert.deepEqual((await loader()).qqBot, { appId: '11111111', appSecret: 'fixture-secret', groupOpenid: 'group-fixture' });
  assert(calls.every(url => url.pathname.includes('/namespaces/fixture-test/')));
});
