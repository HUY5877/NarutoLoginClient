// Run with: node --test tests/frontend-achievements.integration.mjs
// PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE may point to existing dependencies.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const frontend = fileURLToPath(new URL('../src/frontend/', import.meta.url));
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const importLocal = entry => import(pathToFileURL(frontendRequire.resolve(entry)).href);
let chromium;
let skip = '';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
try {
  const entry = process.env.PLAYWRIGHT_MODULE || frontendRequire.resolve('playwright');
  ({ chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(path.resolve(entry)).href));
  if (!existsSync(executablePath || chromium.executablePath())) throw new Error('Chromium unavailable');
} catch {
  skip = 'Playwright/Chromium unavailable. Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing dependencies.';
}

test('the public site achievement shows only task request totals', { skip: skip || false, timeout: 90_000 }, async t => {
  const { createServer } = await importLocal('vite');
  const { default: react } = await importLocal('@vitejs/plugin-react');
  const { default: tailwindcss } = await importLocal('@tailwindcss/vite');
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-achievements-env-'));
  const server = await createServer({ configFile: false, root: frontend, envDir,
    plugins: [react(), tailwindcss()], resolve: { alias: { '@': frontend } },
    server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
  t.after(async () => { await server.close(); await rmdir(envDir); });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());

  async function fixture(t, options = {}) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    const calls = [];
    const errors = [];
    let response = () => ({ status: 200, json: { totalRequests: 12864 } });
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: null } });
      if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true, environment: 'test' } });
      if (url.pathname === '/api/achievements') {
        calls.push(request.method());
        const result = await response();
        return route.fulfill(result).catch(() => {});
      }
      errors.push(`Unexpected API: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: {} });
    });
    await page.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
      window.setTestVisibility = visible => {
        hidden = !visible;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    });
    const card = page.getByRole('region', { name: '全站成就', exact: true });
    return { page, card, total: card.locator('.site-achievement-value strong'), calls,
      respond(handler) { response = handler; },
      async open() {
        await page.goto(origin);
        await card.waitFor();
        assert.equal(await page.getByRole('banner').getByRole('button', { name: '全站成就', exact: true }).count(), 0);
        assert.equal(await page.getByRole('dialog').count(), 0);
      },
      async focus() { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); },
      async setVisible(visible) { await page.evaluate(visible => window.setTestVisibility(visible), visible); },
    };
  }

  async function expectReading(f) {
    await f.card.getByText('正在读取成就统计', { exact: true }).waitFor();
    await f.card.locator('.site-achievement-placeholder').waitFor();
    assert.equal(await f.total.count(), 0);
  }

  await t.test('initial loading displays a placeholder before confirming a real zero', async t => {
    const f = await fixture(t);
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    f.respond(() => response);
    await Promise.all([f.page.waitForRequest(`${origin}/api/achievements`), f.open()]);
    await expectReading(f);
    await f.focus();
    finish({ json: { totalRequests: 0 } });
    await f.total.filter({ hasText: /^0$/ }).waitFor();
    assert.deepEqual(f.calls, ['GET']);
  });

  await t.test('failed and invalid responses show the reading placeholder until a valid reply arrives', async t => {
    const f = await fixture(t);
    const url = `${origin}/api/achievements`;
    const unavailable = { status: 503, json: { error: 'unavailable' } };
    f.respond(() => unavailable);
    const [initial] = await Promise.all([f.page.waitForResponse(url), f.open()]);
    await initial.finished();
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expectReading(f);

    for (const result of [{ json: { totalRequests: -1 } }, unavailable]) {
      f.respond(() => ({ json: { totalRequests: 12864 } }));
      await f.focus();
      await f.total.filter({ hasText: /^12,864$/ }).waitFor();
      f.respond(() => result);
      const [reply] = await Promise.all([f.page.waitForResponse(url), f.focus()]);
      await reply.finished();
      await expectReading(f);
    }
    f.respond(() => ({ json: { totalRequests: 0 } }));
    await f.focus();
    await f.total.filter({ hasText: /^0$/ }).waitFor();
  });

  await t.test('refreshes on schedule while visible and recovers when visibility returns', async t => {
    const f = await fixture(t);
    await f.page.clock.install();
    await f.open();
    await f.total.filter({ hasText: /^12,864$/ }).waitFor();
    await f.page.setViewportSize({ width: 390, height: 844 });
    await f.page.getByRole('tab', { name: '决斗场周胜', exact: true }).click();
    await f.page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await f.card.count(), 1, 'Desktop and mobile share the same counter');
    f.respond(() => ({ json: { totalRequests: 12865 } }));
    await f.page.clock.fastForward(61_000);
    await f.total.filter({ hasText: /^12,865$/ }).waitFor();
    await f.setVisible(false);
    await f.page.clock.fastForward(61_000);
    await f.focus();
    assert.deepEqual(f.calls, ['GET', 'GET']);
    f.respond(() => ({ json: { totalRequests: 12866 } }));
    await f.setVisible(true);
    await f.total.filter({ hasText: /^12,866$/ }).waitFor();
    assert.deepEqual(f.calls, ['GET', 'GET', 'GET']);
  });

  await t.test('a stalled request times out and can be retried on focus', async t => {
    const f = await fixture(t);
    await f.page.clock.install();
    await f.open();
    await f.total.filter({ hasText: /^12,864$/ }).waitFor();
    let finish;
    const pendingResponse = new Promise(resolve => { finish = resolve; });
    f.respond(() => pendingResponse);
    const [stalled] = await Promise.all([f.page.waitForRequest(`${origin}/api/achievements`), f.focus()]);
    const timedOut = f.page.waitForEvent('requestfailed', request => request === stalled);
    await f.page.clock.fastForward(10_000);
    finish({ json: { totalRequests: 999 } });
    await timedOut;
    await expectReading(f);

    f.respond(() => ({ json: { totalRequests: 1 } }));
    await f.focus();
    await f.total.filter({ hasText: /^1$/ }).waitFor();
  });

  await t.test('the home counter and Konan’s registration notice remain accessible at all screen sizes', async t => {
    for (const width of [1280, 768, 390, 320]) {
      const f = await fixture(t, { viewport: { width, height: width < 640 ? 844 : 900 },
        hasTouch: width < 640, reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
      if (width === 320) f.respond(() => ({ json: { totalRequests: Number.MAX_SAFE_INTEGER } }));
      await f.open();
      await f.total.filter({ hasText: width === 320 ? /^9,007,199,254,740,991$/ : /^12,864$/ }).waitFor();
      const avatar = f.card.locator('img[src="/images/konan-achievement.webp?v=98b569de"]');
      await avatar.waitFor();
      await avatar.evaluate(image => image.decode());
      const avatarBox = await avatar.boundingBox();
      assert.ok(avatarBox && avatarBox.width > 0 && avatarBox.height > 0
        && avatarBox.x >= 0 && avatarBox.x + avatarBox.width <= width
        && avatarBox.y >= 0 && avatarBox.y + avatarBox.height <= f.page.viewportSize().height,
        `The original achievement portrait is visible at ${width}px`);
      assert.equal(await f.card.getByText('累计申请', { exact: true }).isVisible(), true);
      const dimensions = await f.card.evaluate(card => ({
        viewportWidth: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth,
        top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom,
        right: card.getBoundingClientRect().right,
        totalRight: card.querySelector('strong').getBoundingClientRect().right,
        glint: getComputedStyle(card, '::after').animationName,
      }));
      assert.ok(dimensions.right <= dimensions.viewportWidth && dimensions.pageWidth <= dimensions.viewportWidth,
        `Page fits at ${width}px: ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.totalRight <= dimensions.right, `Total fits at ${width}px`);
      assert.ok(dimensions.bottom - dimensions.top <= (width < 640 ? 84 : 95),
        `Card stays compact at ${width}px: ${JSON.stringify(dimensions)}`);
      if (width === 320) assert.equal(dimensions.glint, 'none');
      if (process.env.ACHIEVEMENT_SCREENSHOT_DIR && (width === 1280 || width === 390)) {
        const dir = path.resolve(process.env.ACHIEVEMENT_SCREENSHOT_DIR);
        await mkdir(dir, { recursive: true });
        await f.page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
          await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
          window.scrollTo(0, 0);
        });
        const screenshot = path.join(dir, `achievements-${width}.png`);
        await f.page.screenshot({ path: screenshot });
        t.diagnostic(screenshot);
      }
      const portrait = f.page.getByRole('region', { name: '小南立绘', exact: true });
      const notice = portrait.getByRole('note', { name: '注册须知', exact: true });
      await notice.getByText(/注册后请加群.*群主审核/).waitFor();
      assert.equal(await notice.getByText('993904975', { exact: true }).isVisible(), true);
      assert.equal(await f.page.getByRole('button', { name: /注册须知/ }).count(), 0);
      const homeUrl = f.page.url();
      if (width < 640) await notice.tap();
      else await notice.click();
      assert.equal(await f.page.getByRole('dialog').count(), 0);
      assert.equal(f.page.url(), homeUrl);
      assert.equal(f.page.context().pages().length, 1);
      const weekly = f.page.getByRole('tab', { name: '决斗场周胜', exact: true });
      await weekly.click();
      assert.equal(await weekly.getAttribute('aria-selected'), 'true');
      assert.deepEqual(f.calls, ['GET'], 'task selection does not reload the whole-site count');
      await f.page.getByRole('button', { name: '登录 / 注册', exact: true }).first().click();
      const auth = f.page.getByRole('dialog');
      await auth.getByRole('button', { name: '注册账户', exact: true }).click();
      await auth.getByRole('note', { name: '注册审核提醒' }).getByText('993904975', { exact: true }).waitFor();
    }
  });
});
