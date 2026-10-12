import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginTypes, parseLoginType, loginScanApp } from '../src/shared/login-types.js';
import { isRunTask } from '../src/frontend/lib/task-run.js';
import { isDailyPage } from '../src/frontend/lib/admin.js';

test('客户端接受四个渠道及旧记录，拒绝损坏渠道并选择对应扫码应用', () => {
  const at = '2026-10-12T00:00:00.000Z';
  const task = { id: 'test', status: 'queued', createdAt: at, expiresAt: at };
  const page = { items: [{ id: 'test', username: 'test', requestedAt: at, scannedAt: null, completedAt: null, status: 'queued' }],
    total: 1, page: 1, pageSize: 20, date: '2026-10-12', timeZone: 'Asia/Shanghai' };
  for (const loginType of [...loginTypes, undefined]) {
    assert.equal(parseLoginType(loginType), loginType ?? 'android_qq');
    assert.ok(isRunTask({ ...task, loginType }));
    assert.ok(isDailyPage({ ...page, items: [{ ...page.items[0], loginType }] }));
  }
  for (const loginType of [null, '', 'qq', [], true, {}]) {
    assert.equal(parseLoginType(loginType), null);
    assert.equal(isRunTask({ ...task, loginType }), false);
    assert.equal(isDailyPage({ ...page, items: [{ ...page.items[0], loginType }] }), false);
  }
  assert.equal(loginScanApp('ios_wechat'), '微信');
  assert.equal(loginScanApp('android_qq'), 'QQ');
});
