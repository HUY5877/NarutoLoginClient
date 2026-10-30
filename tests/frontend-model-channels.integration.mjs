// Real React UI with isolated Vite and intercepted APIs; no credentials or model calls.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repository, 'src/frontend');
const require = createRequire(path.join(root, 'package.json'));
const previewDir = process.env.MODEL_CHANNEL_PREVIEW_DIR;
let chromium, unavailable = '';
try {
  const entry = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright');
  ({ chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(path.resolve(entry)).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error();
} catch { unavailable = 'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing browser dependencies.'; }

const admin = { id: '10000000-0000-4000-8000-000000000001', username: '管理员账号', isAdmin: true, isInvalid: false };
const channels = [
  { id: 'openai', name: 'OpenAI', version: 'openai-snapshot-1', model: 'gpt-4.1-mini', enabled: true, keys: [{ id: 'openai-v1-0', masked: 'sk-••••1111' }, { id: 'openai-v1-1', masked: 'sk-••••2222' }] },
  { id: 'deepseek', name: 'DeepSeek', version: 'deepseek-snapshot-1', model: 'deepseek-chat', enabled: false, keys: [] },
];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function assertHighlightedResult(result, ok, message, expectedLatency = 88) {
  const title = ok ? '测试成功' : '测试失败';
  assert.equal(await result.getAttribute('data-slot'), 'alert', 'The result uses the shared shadcn Alert');
  assert.equal(await result.getAttribute('role'), ok ? 'status' : 'alert');
  assert.equal(await result.locator('[data-slot="alert-title"]').getByText(title, { exact: true }).count(), 1);
  const description = result.locator('[data-slot="alert-description"]');
  assert.equal(await description.innerText(), message);
  const badge = result.locator('[data-slot="badge"]');
  assert.equal(await badge.count(), 1, 'Latency has its own badge');
  const latency = (await badge.innerText()).match(/^(\d+(?:\.\d+)?)\s*ms$/);
  assert.ok(latency, 'The latency badge contains only the elapsed time');
  assert.ok(Number(latency[1]) > 0, 'The result reports a positive measured latency');
  if (expectedLatency !== null) assert.equal(Number(latency[1]), expectedLatency);
  const icon = result.locator(ok ? 'svg.lucide-circle-check, svg.lucide-check' : 'svg.lucide-circle-x, svg.lucide-x');
  assert.equal(await icon.count(), 1, `${title} has a matching visible icon`);
  assert.equal(await icon.isVisible(), true);
  const colors = await result.evaluate(element => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    return { background: rgba(style.backgroundColor), border: rgba(style.borderTopColor), borderWidth: parseFloat(style.borderTopWidth) };
  });
  assert.ok(colors.borderWidth > 0, 'The result has a visible border');
  for (const part of ['background', 'border']) {
    const [red, green, blue, alpha] = colors[part];
    assert.ok(alpha > 0, `${part} is not transparent`);
    assert.ok(ok ? green > red + 3 && green > blue + 3 : red > green + 3 && red > blue + 3,
      `${title} ${part} should be ${ok ? 'green' : 'red'}, received rgba(${colors[part].join(',')})`);
  }
  assert.equal(await description.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Long result messages wrap inside the description');
  assert.equal(await result.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'The result does not overflow horizontally');
}

test('管理员大模型渠道编辑与逐个密钥测试', { skip: unavailable || false, timeout: 120_000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-channels-empty-env-'));
  const server = await createServer({ configFile: false, root, envDir, plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    if (previewDir) await mkdir(previewDir, { recursive: true });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    async function fixture({ viewport = { width: 1280, height: 900 }, isAdmin = true, readStatus = 200, environment = 'test', brokenChannel = false, missingChannel = false } = {}) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 768, timezoneId: 'Asia/Shanghai' });
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const state = { channels: structuredClone(channels), reads: 0, writes: [], tests: [], errors: [], readStatus,
        writeStatus: 200, testStatus: 200, testOk: true, testMessage: null, gate: null, wrongChannel: false };
      if (brokenChannel) state.channels[0] = { ...state.channels[0], model: '', enabled: false,
        keys: brokenChannel === 'model' ? state.channels[0].keys : [], configurationError: '该渠道配置格式有误，请重新填写并保存。' };
      if (missingChannel) state.channels[0] = { id: 'openai', name: 'OpenAI', version: 'openai-snapshot-missing', model: '', enabled: false, keys: [] };
      page.on('pageerror', error => state.errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const reply = (json, status = 200) => route.fulfill({ status, json });
        if (url.pathname === '/api/health') return reply({ ok: true, environment });
        if (url.pathname === '/api/auth/me') return reply({ user: { ...admin, isAdmin } });
        if (url.pathname === '/api/task-runs/latest') return reply({ task: null });
        if (url.pathname === '/api/admin/model-channels') {
          state.reads += 1;
          return state.readStatus !== 200 ? reply({ error: '渠道读取失败，请重试。' }, state.readStatus) : reply({ environment, channels: state.channels });
        }
        const match = url.pathname.match(/^\/api\/admin\/model-channels\/(openai|deepseek)(\/test)?$/);
        if (match) {
          const body = route.request().postDataJSON();
          if (match[2]) {
            state.tests.push({ id: match[1], body });
            if (state.gate) await state.gate.promise;
            return state.testStatus !== 200 ? reply({ error: state.testStatus >= 500 ? '测试服务暂时不可用，请稍后重试。' : '密钥已变更，请重新读取。' }, state.testStatus)
              : reply({ ok: state.testOk, latencyMs: 88, message: state.testMessage ?? (state.testOk ? '连接成功。' : '密钥不可用。') });
          }
          state.writes.push({ id: match[1], body });
          if (state.gate) await state.gate.promise;
          if (state.writeStatus !== 200) return reply({ error: state.writeStatus === 409 ? '配置已变更，请重新读取。' : '保存失败，请重试。' }, state.writeStatus);
          const current = state.channels.find(channel => channel.id === match[1]);
          if (body.version !== current.version) return reply({ error: '配置已变更，请重新读取。' }, 409);
          const saved = { ...current, ...body, version: `${current.id}-snapshot-${state.writes.length + 1}`, keys: body.keys.map((key, index) => ({ id: `${current.id}-v${state.writes.length + 1}-${index}`, masked: key.id ? current.keys.find(item => item.id === key.id).masked : 'sk-••••9999' })) };
          delete saved.configurationError;
          state.channels = state.channels.map(channel => channel.id === saved.id ? saved : channel);
          return reply(state.wrongChannel ? state.channels.find(channel => channel.id !== saved.id) : saved);
        }
        state.errors.push(`Unexpected API ${route.request().method()} ${url.pathname}`);
        return reply({}, 404);
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const dialog = page.getByRole('dialog', { name: '大模型渠道', exact: true });
      async function open() {
        await page.getByRole('button', { name: /^(管理员|管理员账号)$/ }).click();
        await page.getByRole('menuitem', { name: '大模型渠道', exact: true }).click();
        await dialog.waitFor();
      }
      if (isAdmin) await open();
      return { page, context, dialog, state, open,
        card: name => dialog.getByRole('group', { name: `${name}渠道`, exact: true }),
        async close() { state.gate?.resolve(); await context.close(); assert.deepEqual(state.errors, []); } };
    }

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 932 }]) {
      const screen = viewport.width < 768 ? 'mobile' : 'desktop';
      await t.test(`${screen}只提供OpenAI和DeepSeek两个管理渠道，不显示鱼玩卡片或操作入口`, async () => {
        const f = await fixture({ viewport, missingChannel: true });
        try {
          await f.card('OpenAI').getByLabel('模型名称').waitFor();
          await f.card('DeepSeek').getByLabel('模型名称').waitFor();
          assert.equal(await f.dialog.getByRole('group').count(), 2);
          assert.equal(await f.dialog.getByRole('group', { name: /鱼玩|yuwan/i }).count(), 0);
          assert.equal(await f.dialog.getByRole('button', { name: /鱼玩|yuwan/i }).count(), 0);
          assert.equal(await f.dialog.getByRole('switch', { name: /鱼玩|yuwan/i }).count(), 0);
          assert.doesNotMatch(await f.dialog.innerText(), /鱼玩|yuwan/i);
          assert.equal(await f.dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
          if (previewDir) await f.page.screenshot({ path: path.join(previewDir, `model-channels-two-${screen}.png`), animations: 'disabled' });
        } finally { await f.close(); }
      });
    }

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const screen = viewport.width < 768 ? 'mobile' : 'desktop';
      await t.test(`${screen}连通性结果以绿红Alert区分，图标标题耗时清晰且长消息不溢出`, async () => {
        const f = await fixture({ viewport });
        try {
          const card = f.card('OpenAI');
          for (const ok of [true, false]) {
            f.state.testOk = ok;
            f.state.testMessage = `${ok ? '模型连接正常，可以继续使用。' : '模型连接失败，请检查密钥和模型名称后重试。'} ${'long_connection_detail_without_spaces_'.repeat(5)}`;
            await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
            const result = card.getByRole(ok ? 'status' : 'alert').filter({ hasText: ok ? '测试成功' : '测试失败' });
            await result.waitFor();
            await assertHighlightedResult(result, ok, f.state.testMessage);
            assert.equal(await f.dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
            if (screen === 'mobile') {
              assert.equal(await result.locator('[data-slot="alert-description"]').evaluate(element =>
                element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight) * 1.5), true, 'The mobile message spans multiple lines');
            }
            if (previewDir) {
              await result.scrollIntoViewIfNeeded();
              await f.page.screenshot({ path: path.join(previewDir, `model-channel-result-${screen}-${ok ? 'success' : 'failure'}.png`), animations: 'disabled' });
            }
          }
          assert.equal(f.state.tests.length, 2);
          assert.deepEqual(f.state.writes, [], 'Displaying results never saves channel settings');
        } finally { await f.close(); }
      });
    }

    await t.test('测试接口503只把当前密钥标红，保留其他密钥的成功结果并显示实测耗时', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        const firstKey = card.getByLabel('密钥 1', { exact: true }).locator('..');
        const secondKey = card.getByLabel('密钥 2', { exact: true }).locator('..');
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        const successful = firstKey.getByRole('status').filter({ hasText: '测试成功' });
        await successful.waitFor();
        if (previewDir) await successful.screenshot({ path: path.join(previewDir, 'model-channel-result-preview.png'), animations: 'disabled' });
        f.state.testStatus = 503;
        await card.getByRole('button', { name: '测试密钥 2', exact: true }).click();
        const failed = secondKey.getByRole('alert').filter({ hasText: '测试失败' });
        await failed.waitFor();
        await assertHighlightedResult(failed, false, '测试服务暂时不可用，请稍后重试。', null);
        await assertHighlightedResult(firstKey.getByRole('status'), true, '连接成功。');
        assert.equal(await firstKey.getByRole('alert').count(), 0);
        assert.equal(await card.getByRole('alert').count(), 1);
        assert.equal(await card.getByRole('button', { name: '测试密钥 2', exact: true }).isDisabled(), false);
        assert.equal(f.state.tests.length, 2);
        assert.deepEqual(f.state.writes, []);
      } finally { await f.close(); }
    });

    await t.test('测试409显示当前密钥红块，编辑后清除结果但保留刷新指引和禁用状态', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        f.state.testStatus = 409;
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        const failed = card.getByRole('alert').filter({ hasText: '测试失败' });
        await failed.waitFor();
        await assertHighlightedResult(failed, false, '当前配置已变更，请重新读取配置后再测试。', null);
        assert.equal(await card.getByRole('button', { name: '测试密钥 2', exact: true }).isDisabled(), true);
        await card.getByLabel('模型名称').fill('updated-draft-model');
        assert.equal(await card.getByRole('alert').filter({ hasText: '测试失败' }).count(), 0);
        const guidance = card.getByRole('alert');
        assert.equal(await guidance.count(), 1);
        assert.match(await guidance.innerText(), /重新读取.*丢弃未保存修改/);
        assert.equal(await card.getByRole('button', { name: '测试密钥 1', exact: true }).isDisabled(), true);
        assert.equal(await card.getByRole('button', { name: '保存渠道', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.getByRole('button', { name: /重新读取/ }).isDisabled(), false);
        assert.equal(f.state.tests.length, 1);
        assert.deepEqual(f.state.writes, []);
      } finally { await f.close(); }
    });

    await t.test('渠道KV全部缺失时可从默认空配置首次填写、启用并保存', async () => {
      const f = await fixture({ missingChannel: true });
      try {
        const card = f.card('OpenAI');
        await card.getByLabel('模型名称').waitFor();
        assert.equal(await card.getByLabel('模型名称').inputValue(), '');
        assert.equal(await card.getByRole('switch').getAttribute('aria-checked'), 'false');
        assert.equal(await card.locator('input[type="password"]').count(), 0);
        assert.equal(await f.dialog.getByRole('alert').count(), 0);
        await card.getByLabel('模型名称').fill('created-model');
        await card.getByRole('button', { name: '新增密钥', exact: true }).click();
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-created-fixture-9999');
        await card.getByRole('switch').click();
        const saving = f.page.waitForRequest(request => new URL(request.url()).pathname === '/api/admin/model-channels/openai');
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        const request = await saving;
        assert.equal(request.method(), 'PUT');
        assert.deepEqual(request.postDataJSON(), { version: 'openai-snapshot-missing', model: 'created-model', enabled: true,
          keys: [{ value: 'sk-created-fixture-9999' }] });
        await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        await card.getByText('sk-••••9999', { exact: true }).waitFor();
        assert.equal(await card.getByLabel('密钥 1', { exact: true }).inputValue(), '');
        assert.equal(await card.getByLabel('模型名称').inputValue(), 'created-model');
        assert.equal(await card.getByRole('switch').getAttribute('aria-checked'), 'true');
        assert.equal(await card.getByRole('alert').count(), 0);
        assert.equal(f.state.writes.length, 1);
        assert.deepEqual(f.state.tests, []);
      } finally { await f.close(); }
    });

    await t.test('修复坏模型时保留已有密钥，保存前仅允许测试新填密钥', async () => {
      const f = await fixture({ brokenChannel: 'model' });
      try {
        const card = f.card('OpenAI');
        await card.getByRole('alert').filter({ hasText: '配置格式有误' }).waitFor();
        await card.getByLabel('模型名称').fill('repaired-model');
        assert.equal(await card.getByRole('button', { name: '测试密钥 1', exact: true }).isDisabled(), true);
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-new-test');
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '88' }).waitFor();
        assert.deepEqual(f.state.tests.at(-1), { id: 'openai', body: { model: 'repaired-model', key: { value: 'sk-new-test' } } });
        await card.getByLabel('密钥 1', { exact: true }).fill('');
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        assert.deepEqual(f.state.writes.at(-1).body.keys, [{ id: 'openai-v1-0' }, { id: 'openai-v1-1' }]);
        assert.equal(await card.getByRole('alert').count(), 0);
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '88' }).waitFor();
        assert.deepEqual(f.state.tests.at(-1), { id: 'openai', body: { model: 'repaired-model', key: { id: 'openai-v2-0' } } });
      } finally { await f.close(); }
    });

    for (const repair of ['clear', 'replace']) {
      await t.test(`配置损坏只提示对应渠道，其他渠道可保存，${repair}可修复`, async () => {
        const f = await fixture({ brokenChannel: true });
        try {
          const broken = f.card('OpenAI'), healthy = f.card('DeepSeek');
          await broken.getByRole('alert').filter({ hasText: '配置格式有误' }).waitFor();
          assert.equal(await healthy.getByRole('alert').count(), 0);
          await healthy.getByLabel('模型名称').fill('healthy-model');
          await healthy.getByRole('button', { name: '保存渠道', exact: true }).click();
          await healthy.getByRole('status').filter({ hasText: '已保存' }).waitFor();
          if (repair === 'replace') {
            await broken.getByLabel('模型名称').fill('repaired-model');
            await broken.getByRole('button', { name: '新增密钥', exact: true }).click();
            await broken.getByLabel('密钥 1', { exact: true }).fill('sk-repair');
            await broken.getByRole('switch').click();
          }
          await broken.getByRole('button', { name: '保存渠道', exact: true }).click();
          await broken.getByRole('status').filter({ hasText: '已保存' }).waitFor();
          assert.equal(await broken.getByRole('alert').count(), 0);
          assert.deepEqual(f.state.writes.at(-1), { id: 'openai', body: repair === 'replace'
            ? { version: 'openai-snapshot-1', model: 'repaired-model', enabled: true, keys: [{ value: 'sk-repair' }] }
            : { version: 'openai-snapshot-1', model: '', enabled: false, keys: [] } });
        } finally { await f.close(); }
      });
    }

    for (const action of ['删除全部', '替换全部']) {
      await t.test(`${action}密钥仍带读取版本，并阻止覆盖他人的修改`, async () => {
        const f = await fixture();
        try {
          const card = f.card('OpenAI');
          await card.getByLabel('模型名称').waitFor();
          if (action === '删除全部') {
            await card.getByRole('button', { name: '删除密钥 2', exact: true }).click();
            await card.getByRole('button', { name: '删除密钥 1', exact: true }).click();
          } else {
            await card.getByLabel('密钥 1', { exact: true }).fill('sk-new-first');
            await card.getByLabel('密钥 2', { exact: true }).fill('sk-new-second');
          }
          f.state.channels[0].version = 'openai-snapshot-external';
          await card.getByRole('button', { name: '保存渠道', exact: true }).click();
          await card.getByRole('alert').waitFor();
          assert.deepEqual(f.state.writes.at(-1).body, { version: 'openai-snapshot-1', model: 'gpt-4.1-mini',
            enabled: action !== '删除全部', keys: action === '删除全部' ? [] : [{ value: 'sk-new-first' }, { value: 'sk-new-second' }] });
          assert.equal(await card.getByRole('button', { name: '保存渠道', exact: true }).isDisabled(), true);
          await f.dialog.getByRole('button', { name: /重新读取/ }).click();
          await f.page.waitForFunction(() => !document.querySelector('[aria-label="OpenAI渠道"] button:last-child')?.disabled
            && document.querySelectorAll('[aria-label="OpenAI渠道"] input[type="password"]').length === 2);
          await card.getByRole('button', { name: '保存渠道', exact: true }).click();
          await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
          assert.equal(f.state.writes.at(-1).body.version, 'openai-snapshot-external');
        } finally { await f.close(); }
      });
    }

    await t.test('仅显示脱敏密钥，保留、替换、添加和删除按预期保存，保存后使用新ID', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        await card.getByText('sk-••••1111', { exact: true }).waitFor();
        await f.dialog.getByText('当前环境：test', { exact: true }).waitFor();
        if (previewDir) await f.page.screenshot({ path: path.join(previewDir, 'model-channels-desktop.png'), animations: 'disabled' });
        assert.equal(await card.getByLabel('密钥 1', { exact: true }).inputValue(), '');
        assert.equal(await card.getByLabel('密钥 1', { exact: true }).getAttribute('type'), 'password');
        await card.getByLabel('模型名称').fill('unsaved-model');
        await card.getByRole('button', { name: '删除密钥 2', exact: true }).click();
        await card.getByRole('button', { name: '新增密钥', exact: true }).click();
        await card.getByLabel('密钥 2', { exact: true }).fill('sk-new-secret');
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        assert.deepEqual(f.state.writes, [{ id: 'openai', body: { version: 'openai-snapshot-1', model: 'unsaved-model', enabled: true, keys: [{ id: 'openai-v1-0' }, { value: 'sk-new-secret' }] } }]);
        assert.equal(await card.getByLabel('密钥 2', { exact: true }).inputValue(), '');
        await card.getByRole('button', { name: '测试密钥 2', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '88' }).waitFor();
        assert.deepEqual(f.state.tests.at(-1), { id: 'openai', body: { model: 'unsaved-model', key: { id: 'openai-v2-1' } } });
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-replaced-secret');
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('#channel-openai-key-0')?.value === '');
        assert.deepEqual(f.state.writes.at(-1).body.keys, [{ value: 'sk-replaced-secret' }, { id: 'openai-v2-1' }]);
        assert.equal(f.state.writes.at(-1).body.version, 'openai-snapshot-2', 'The next save uses the version returned by the previous save');
        assert.doesNotMatch(await f.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /sk-new-secret|sk-replaced-secret/);
      } finally { await f.close(); }
    });

    await t.test('测试使用当前未保存的模型和单条密钥，不保存也不遍历其他密钥', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        await card.getByLabel('模型名称').fill('draft-model');
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-draft-key');
        const readsBeforeTest = f.state.reads;
        f.state.gate = deferred();
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        assert.equal(await card.getByRole('button', { name: '保存渠道', exact: true }).isDisabled(), true);
        assert.equal(await card.getByRole('button', { name: '测试密钥 2', exact: true }).isDisabled(), true);
        assert.equal(await f.dialog.getByRole('button', { name: /重新读取/ }).isDisabled(), true);
        f.state.gate.resolve();
        await card.getByRole('status').filter({ hasText: '88' }).waitFor();
        assert.deepEqual(f.state.tests, [{ id: 'openai', body: { model: 'draft-model', key: { value: 'sk-draft-key' } } }]);
        assert.deepEqual(f.state.writes, []);
        assert.equal(f.state.reads, readsBeforeTest);
        await card.getByLabel('模型名称').fill('another-model');
        assert.equal(await card.getByRole('status').filter({ hasText: '88' }).count(), 0, 'Changing model clears the result for the previous model');
        f.state.testOk = false;
        await card.getByRole('button', { name: '测试密钥 2', exact: true }).click();
        await card.getByRole('alert').filter({ hasText: '密钥不可用' }).waitFor();
        assert.equal(await card.getByLabel('密钥 1', { exact: true }).inputValue(), 'sk-draft-key');
      } finally { await f.close(); }
    });

    await t.test('删除最后一条密钥会关闭渠道；空模型和空新密钥不能提交', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        await card.getByRole('button', { name: '删除密钥 2', exact: true }).click();
        await card.getByRole('button', { name: '删除密钥 1', exact: true }).click();
        assert.equal(await card.getByRole('switch').getAttribute('aria-checked'), 'false');
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        assert.deepEqual(f.state.writes.at(-1), { id: 'openai', body: { version: 'openai-snapshot-1', model: 'gpt-4.1-mini', enabled: false, keys: [] } });
        await card.getByRole('button', { name: '新增密钥', exact: true }).click();
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('alert').waitFor();
        assert.equal(f.state.writes.length, 1);
        await card.getByLabel('密钥 1', { exact: true }).fill('fixture');
        await card.getByLabel('模型名称').fill(' ');
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        await card.getByRole('alert').filter({ hasText: '模型' }).waitFor();
        assert.equal(f.state.tests.length, 0);
      } finally { await f.close(); }
    });

    await t.test('关闭渠道可保存空模型，启用或测试仍必须填写模型', async () => {
      const f = await fixture();
      try {
        const card = f.card('DeepSeek');
        await card.getByLabel('模型名称').fill(' ');
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        assert.deepEqual(f.state.writes, [{ id: 'deepseek', body: { version: 'deepseek-snapshot-1', model: '', enabled: false, keys: [] } }]);
        await card.getByRole('button', { name: '新增密钥', exact: true }).click();
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-model-required');
        await card.getByRole('button', { name: '测试密钥 1', exact: true }).click();
        await card.getByRole('alert').filter({ hasText: '模型' }).waitFor();
        assert.equal(f.state.tests.length, 0);
        await card.getByRole('switch').click();
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('alert').filter({ hasText: '模型' }).waitFor();
        assert.equal(f.state.writes.length, 1);
      } finally { await f.close(); }
    });

    await t.test('保存冲突保留草稿，阻止使用旧ID重试，重新读取后恢复', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        await card.getByLabel('模型名称').fill('keep-draft');
        f.state.writeStatus = 409;
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('alert').waitFor();
        assert.equal(await card.getByLabel('模型名称').inputValue(), 'keep-draft');
        assert.equal(await card.getByRole('button', { name: '保存渠道', exact: true }).isDisabled(), true);
        assert.equal(await card.getByRole('button', { name: '测试密钥 1', exact: true }).isDisabled(), true);
        await f.dialog.getByRole('button', { name: /重新读取/ }).click();
        await card.getByRole('button', { name: '保存渠道', exact: true }).waitFor({ state: 'visible' });
        await f.page.waitForFunction(() => document.querySelector('#channel-openai-model')?.value === 'gpt-4.1-mini');
        assert.equal(await card.getByRole('button', { name: '保存渠道', exact: true }).isDisabled(), false);
      } finally { await f.close(); }
    });

    await t.test('读取错误可以重试；普通保存错误保留输入并允许重试', async () => {
      const f = await fixture({ readStatus: 503 });
      try {
        await f.dialog.getByRole('alert').waitFor();
        f.state.readStatus = 200;
        await f.dialog.getByRole('button', { name: /重新读取/ }).click();
        const card = f.card('OpenAI');
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-retry');
        f.state.writeStatus = 503;
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('alert').waitFor();
        assert.equal(await card.getByLabel('密钥 1', { exact: true }).inputValue(), 'sk-retry');
        f.state.writeStatus = 200;
        await card.getByRole('button', { name: '保存渠道', exact: true }).click();
        await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        assert.equal(f.state.writes.length, 2);
      } finally { await f.close(); }
    });

    await t.test('重复点击只保存一次；返回其他渠道不能当作保存成功', async () => {
      const f = await fixture();
      try {
        const card = f.card('OpenAI');
        await card.getByLabel('模型名称').fill('draft-model');
        f.state.gate = deferred();
        f.state.wrongChannel = true;
        const save = card.getByRole('button', { name: '保存渠道', exact: true });
        await save.click();
        await save.dispatchEvent('click');
        assert.equal(await save.isDisabled(), true);
        f.state.gate.resolve();
        await card.getByRole('alert').waitFor();
        assert.equal(f.state.writes.length, 1);
        assert.equal(await save.isDisabled(), true);
        assert.equal(await card.getByLabel('模型名称').inputValue(), 'draft-model');
        assert.equal(await card.getByRole('status').filter({ hasText: '已保存' }).count(), 0);
      } finally { await f.close(); }
    });

    for (const action of ['read', 'write', 'test']) {
      await t.test(`${action}权限过期关闭弹窗并移除密钥输入`, async () => {
        const f = await fixture();
        try {
          const card = f.card('OpenAI');
          await card.getByLabel('密钥 1', { exact: true }).fill('sk-expired-secret');
          if (action === 'read') { f.state.readStatus = 401; await f.dialog.getByRole('button', { name: /重新读取/ }).click(); }
          if (action === 'write') { f.state.writeStatus = 403; await card.getByRole('button', { name: '保存渠道', exact: true }).click(); }
          if (action === 'test') { f.state.testStatus = 401; await card.getByRole('button', { name: '测试密钥 1', exact: true }).click(); }
          await f.dialog.waitFor({ state: 'hidden' });
          assert.equal(await f.page.locator('input[type="password"]').count(), 0);
        } finally { await f.close(); }
      });
    }

    await t.test('普通用户不显示管理入口，也不读取渠道', async () => {
      const f = await fixture({ isAdmin: false });
      try { assert.equal(await f.page.getByRole('button', { name: '管理员', exact: true }).count(), 0); assert.equal(f.state.reads, 0); }
      finally { await f.close(); }
    });

    await t.test('移动端不横向溢出，关闭再打开清空未保存密钥，限制最多20个密钥', async () => {
      const f = await fixture({ viewport: { width: 390, height: 844 }, environment: 'prod' });
      try {
        const card = f.card('DeepSeek');
        await f.dialog.getByText('当前环境：prod', { exact: true }).waitFor();
        if (previewDir) await f.page.screenshot({ path: path.join(previewDir, 'model-channels-mobile.png'), animations: 'disabled' });
        await card.getByRole('button', { name: '新增密钥', exact: true }).click();
        await card.getByLabel('密钥 1', { exact: true }).fill('sk-unsaved');
        await card.getByLabel('密钥 1', { exact: true }).fill('密'.repeat(513));
        assert.equal(await card.getByLabel('密钥 1', { exact: true }).inputValue(), '密'.repeat(512));
        await card.getByLabel('模型名称').fill('型'.repeat(201));
        assert.equal(await card.getByLabel('模型名称').inputValue(), '型'.repeat(200));
        const bounds = await f.dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        assert.equal(await f.dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await f.page.keyboard.press('Escape');
        await f.dialog.waitFor({ state: 'hidden' });
        await f.open();
        await card.getByLabel('模型名称').waitFor();
        assert.equal(await card.locator('input[type="password"]').count(), 0);
        for (let index = 0; index < 20; index++) await card.getByRole('button', { name: '新增密钥', exact: true }).click();
        assert.equal(await card.locator('input[type="password"]').count(), 20);
        assert.equal(await card.getByRole('button', { name: '新增密钥', exact: true }).isDisabled(), true);
      } finally { await f.close(); }
    });
  } finally { await browser?.close(); await server.close(); await rmdir(envDir); }
});
