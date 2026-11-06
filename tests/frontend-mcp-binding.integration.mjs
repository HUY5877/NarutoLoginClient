import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repository, 'src/frontend');
const require = createRequire(path.join(root, 'package.json'));
let chromium, skip = '';
try {
  const entry = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright');
  ({ chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(path.resolve(entry)).href));
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath())) throw new Error();
} catch { skip = 'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing browser dependencies.'; }
const token = 'a'.repeat(43);
const first = { id: '10000000-0000-4000-8000-000000000001', username: '第一位用户' };
const second = { id: '10000000-0000-4000-8000-000000000002', username: '第二位用户' };
const preview = { qq: '123456789', expiresAt: '2026-11-06T12:05:00Z' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const waitFor = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('expected API request'); };

test('MCP link confirmation uses the real dialog and isolated account state', { skip: skip || false, timeout: 120_000 }, async t => {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-mcp-binding-env-'));
  const wrapper = `import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {McpBindingDialog} from '/components/mcp-binding-dialog.tsx';
    import '/styles.css';
    function Fixture() {
      const [props, update] = useState({user:null, authLoading:false, loginOpen:false});
      window.updateBindingProps = change => update(p => ({...p,...change}));
      return React.createElement(React.Fragment,null,
        React.createElement('button',{onClick:()=>update(p=>({...p,loginOpen:false,user:${JSON.stringify(first)}}))},'模拟登录完成'),
        React.createElement(McpBindingDialog,{...props,onLogin:()=>update(p=>({...p,loginOpen:true})),
          onUnauthorized:()=>{window.unauthorized=(window.unauthorized||0)+1;update(p=>({...p,user:null}));}}));
    } createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
  const server = await createServer({ configFile: false, root, envDir,
    plugins: [{ name: 'mcp-dialog-test', resolveId(id) { if (id === 'virtual:mcp-test') return '\0mcp-test'; },
      load(id) { if (id === '\0mcp-test') return { code: wrapper, map: null }; },
      configureServer(s) { s.middlewares.use('/__mcp_test', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(await s.transformIndexHtml('/__mcp_test', '<html><body><div id="root"></div><script type="module" src="/@id/virtual:mcp-test"></script></body></html>'));
      }); } }, react(), tailwindcss()],
    resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 0,
      fs: { allow: [repository, realpathSync(path.join(root, 'node_modules'))] } }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    async function fixture() {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage(); page.setDefaultTimeout(5_000);
      const state = { calls: [], errors: [], handler: null };
      page.on('pageerror', error => state.errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        state.calls.push({ path: url.pathname, body: route.request().postDataJSON(), method: route.request().method(), url: route.request().url() });
        const result = state.handler ? await state.handler(url.pathname) : { json: url.pathname.endsWith('/preview') ? preview : { qq: preview.qq, userId: first.id, boundAt: '2026-11-06T12:00:00Z' } };
        await route.fulfill({ status: result.status || 200, json: result.json }).catch(() => {});
      });
      await page.goto(`${origin}/__mcp_test#mcp-bind=${token}`);
      const update = change => page.evaluate(change => window.updateBindingProps(change), change);
      return { page, state, update, async close() { await context.close(); assert.deepEqual(state.errors, []); } };
    }
    await t.test('login, preview and explicit confirmation do not leak token or mutate early', async () => {
      const f = await fixture();
      try {
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        assert.deepEqual(f.state.calls, []);
        await f.page.getByRole('button', { name: '登录网站账号', exact: true }).click();
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        await f.page.getByRole('button', { name: '模拟登录完成' }).click();
        await f.page.getByText(preview.qq, { exact: true }).waitFor();
        await f.page.getByText(first.username, { exact: true }).waitFor();
        assert.deepEqual(f.state.calls.map(c => c.path), ['/api/mcp-bindings/preview']);
        await f.page.getByRole('button', { name: '确认绑定', exact: true }).click();
        await f.page.getByText('绑定成功', { exact: true }).waitFor();
        await f.page.getByText(`QQ ${preview.qq} 已绑定到 ${first.username}。`, { exact: true }).waitFor();
        assert.equal(new URL(f.page.url()).hash, '');
        assert.deepEqual(f.state.calls.map(c => [c.method, c.body]), [['POST', { token }], ['POST', { token, expectedUserId: first.id }]]);
        assert.ok(f.state.calls.every(c => !c.url.includes(token)));
        assert.equal(await f.page.evaluate(t => Object.values(localStorage).includes(t) || Object.values(sessionStorage).includes(t), token), false);
        await f.update({ user: second });
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(await f.page.getByText('绑定成功', { exact: true }).count(), 0);
      } finally { await f.close(); }
    });
    await t.test('a changed Cookie account requires login and a fresh explicit confirmation', async () => {
      const f = await fixture();
      try {
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        await f.update({ user: first });
        await f.page.getByText(first.username, { exact: true }).waitFor();
        f.state.handler = () => ({ status: 409, json: { code: 'MCP_BINDING_ACCOUNT_CHANGED', error: '登录账号已变化，请重新核对。' } });
        await f.page.getByRole('button', { name: '确认绑定', exact: true }).click();
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        assert.equal(await f.page.evaluate(() => window.unauthorized), 1);
        assert.deepEqual(f.state.calls.at(-1).body, { token, expectedUserId: first.id });
        assert.equal(new URL(f.page.url()).hash, `#mcp-bind=${token}`);
        assert.equal(f.state.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
        f.state.handler = pathname => ({ json: pathname.endsWith('/preview') ? preview
          : { qq: preview.qq, userId: second.id, boundAt: '2026-11-06T12:00:00Z' } });
        await f.update({ user: second });
        await f.page.getByText(second.username, { exact: true }).waitFor();
        await f.page.waitForTimeout(100);
        assert.equal(f.state.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
        await f.page.getByRole('button', { name: '确认绑定', exact: true }).click();
        await f.page.getByText('绑定成功', { exact: true }).waitFor();
        assert.deepEqual(f.state.calls.at(-1).body, { token, expectedUserId: second.id });
      } finally { await f.close(); }
    });
    await t.test('account changes discard late preview, success and error responses', async () => {
      const f = await fixture(); const old = deferred();
      try {
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        f.state.handler = () => old.promise;
        await f.update({ user: first }); await waitFor(() => f.state.calls.length === 1);
        f.state.handler = () => ({ json: { ...preview, qq: '987654321' } });
        await f.update({ user: second });
        await f.page.getByText('987654321', { exact: true }).waitFor();
        old.resolve({ status: 409, json: { error: '旧账号错误' } });
        await f.page.waitForTimeout(100);
        assert.equal(await f.page.getByText('旧账号错误').count(), 0);
        assert.equal(await f.page.getByText(first.username, { exact: true }).count(), 0);
        const confirm = deferred(); f.state.handler = () => confirm.promise;
        await f.page.getByRole('button', { name: '确认绑定', exact: true }).click();
        await waitFor(() => f.state.calls.length === 3);
        assert.equal(await f.page.getByRole('button', { name: '确认绑定', exact: true }).isDisabled(), true);
        f.state.handler = () => ({ json: preview }); await f.update({ user: first });
        await f.page.getByText(preview.qq, { exact: true }).waitFor();
        confirm.resolve({ json: { qq: '987654321', userId: second.id, boundAt: '2026-11-06T12:00:00Z' } });
        await f.page.waitForTimeout(100);
        assert.equal(await f.page.getByText('绑定成功', { exact: true }).count(), 0);
        assert.equal(new URL(f.page.url()).hash, `#mcp-bind=${token}`);
      } finally { old.resolve({ json: preview }); await f.close(); }
    });
    await t.test('auth loading, retry, unauthorized and cancellation remain safe', async () => {
      const f = await fixture();
      try {
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        await f.update({ user: first, authLoading: true });
        await f.page.getByText('正在确认登录状态…', { exact: true }).waitFor();
        assert.deepEqual(f.state.calls, []);
        f.state.handler = () => ({ status: 503, json: { error: '绑定服务暂不可用' } });
        await f.update({ authLoading: false });
        await f.page.getByRole('alert').getByText('绑定服务暂不可用').waitFor();
        f.state.handler = () => ({ status: 401, json: { error: '登录已过期' } });
        await f.page.getByRole('button', { name: '重试', exact: true }).click();
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        assert.equal(await f.page.evaluate(() => window.unauthorized), 1);
        await f.page.evaluate(() => { location.hash = 'other-section'; });
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(new URL(f.page.url()).hash, '#other-section');
        await f.page.evaluate(t => { location.hash = `mcp-bind=${t}`; }, token);
        await f.page.getByRole('button', { name: '取消', exact: true }).click();
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(new URL(f.page.url()).hash, '');
      } finally { await f.close(); }
    });
    await t.test('canceling an in-flight confirmation ignores late success and leaves another fragment intact', async () => {
      const f = await fixture(); const pending = deferred();
      try {
        await f.page.getByText('登录网站账号后确认绑定', { exact: true }).waitFor();
        await f.update({ user: first });
        await f.page.getByText(preview.qq, { exact: true }).waitFor();
        f.state.handler = () => pending.promise;
        await f.page.getByRole('button', { name: '确认绑定', exact: true }).click();
        await waitFor(() => f.state.calls.length === 2);
        await f.page.getByRole('button', { name: '取消', exact: true }).click();
        await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
        await f.page.evaluate(() => { location.hash = 'another-section'; });
        pending.resolve({ json: { qq: preview.qq, userId: first.id, boundAt: '2026-11-06T12:00:00Z' } });
        await f.page.waitForTimeout(100);
        assert.equal(await f.page.getByText('绑定成功', { exact: true }).count(), 0);
        assert.equal(new URL(f.page.url()).hash, '#another-section');
        assert.equal(f.state.calls.length, 2);
      } finally { pending.resolve({ json: {} }); await f.close(); }
    });
  } finally { await browser?.close(); await server.close(); await rmdir(envDir); }
});
