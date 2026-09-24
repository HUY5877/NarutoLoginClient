import assert from 'node:assert/strict';
import test from 'node:test';
import { expireLoginSession } from '../src/frontend/lib/login-expiry';
import type { Session } from '../src/frontend/hooks/use-login-session';

const queued: Session = { id: 'task', status: 'queued', createdAt: '2026-09-24T01:00:00Z',
  expiresAt: '2026-09-24T01:02:00Z', simulation: true };

test('local expiry and an API expired response preserve unclaimed queue timeout', () => {
  for (const ended of [expireLoginSession(queued), expireLoginSession({ ...queued, status: 'expired' }, queued)]) {
    assert.equal(ended.status, 'expired');
    assert.equal(ended.errorCode, 'queue_timeout');
    assert.equal(ended.error, '服务器可用实例紧张，请稍后再试。');
    assert.deepEqual(expireLoginSession(ended), ended);
  }
});

test('claimed tasks, unknown expiry, and other requests do not become queue timeouts', () => {
  for (const status of ['starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready', 'expired'] as const) {
    const claimed = { ...queued, status };
    assert.equal(expireLoginSession(claimed).errorCode, undefined);
    assert.equal(expireLoginSession({ ...claimed, status: 'expired' }, claimed).errorCode, undefined);
  }
  assert.equal(expireLoginSession({ ...queued, id: 'new-task', status: 'expired' }, queued).errorCode, undefined);
  const failed: Session = { ...queued, status: 'failed', errorCode: 'worker_clock_skew' };
  assert.deepEqual(expireLoginSession(failed, queued), failed);
});
