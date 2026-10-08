import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDailyPage, isUserResponse, isUsersPage, formatAdminDate } from '../src/frontend/lib/admin.js';

const user = { id: 'user', username: 'Naruto', isAdmin: false, isInvalid: false, createdAt: '2026-10-08T16:00:00.000Z', applicationStatus: null };
test('administrator responses validate timestamps, roles, pagination and known task states', () => {
  assert.ok(isUserResponse({ user }));
  assert.ok(isUsersPage({ items: [user], page: 1, pageSize: 20, total: 1 }));
  for (const invalid of [{ ...user, isAdmin: 'true' }, { ...user, isInvalid: 0 }, { ...user, createdAt: 'broken' }, { ...user, applicationStatus: 'active' }])
    assert.equal(isUserResponse({ user: invalid }), false);
  const daily = { items: [{ id: 'task', username: 'Naruto', requestedAt: user.createdAt, scannedAt: null, completedAt: null, status: 'running_daily' }],
    page: 1, pageSize: 20, total: 1, date: '2026-10-09', timeZone: 'Asia/Shanghai' };
  assert.ok(isDailyPage(daily));
  assert.equal(isDailyPage({ ...daily, items: [{ ...daily.items[0], status: 'unknown' }] }), false);
  assert.equal(isDailyPage({ ...daily, items: [{ ...daily.items[0], completedAt: 'broken' }] }), false);
  assert.equal(isDailyPage({ ...daily, total: -1 }), false);
  assert.equal(isDailyPage({ ...daily, timeZone: 'UTC' }), false);
  assert.equal(formatAdminDate(null), '—');
  assert.match(formatAdminDate(user.createdAt), /2026\D+10\D+09.*00:00:00/);
});
