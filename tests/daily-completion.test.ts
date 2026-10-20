import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDailyMilestoneAt } from '../src/shared/daily-completion.js';

const startedAt = '2026-10-19T10:00:00.000Z';
const secretRealmCompletedAt = '2026-10-19T10:20:00.000Z';
const run = { startedAt, secretRealmCompletedAt };

test('首次秘境完成标记兼容缺省日常选项和两种秘境模式', () => {
  assert.equal(getDailyMilestoneAt(run), secretRealmCompletedAt);
  for (const mainTask of [undefined, 'daily'] as const) for (const secretRealmMode of ['once', 'all'] as const) {
    assert.equal(getDailyMilestoneAt(run, { equipmentStamina: false, secretRealmMode,
      ...(mainTask ? { mainTask } : {}) }), secretRealmCompletedAt);
  }
});

test('跳过秘境及周胜任务不能将标记视为日常完成', () => {
  assert.equal(getDailyMilestoneAt(run, { equipmentStamina: true, secretRealmMode: 'skip' }), null);
  for (const secretRealmMode of ['once', 'all', 'skip'] as const) {
    assert.equal(getDailyMilestoneAt(run, { mainTask: 'arena_weekly', equipmentStamina: true, secretRealmMode }), null);
  }
});

test('缺少开始时间或首次秘境标记及无效时间均不能推断日常完成', () => {
  for (const value of [null, {}, { startedAt }, { secretRealmCompletedAt }, { startedAt: null, secretRealmCompletedAt },
    { startedAt: '', secretRealmCompletedAt }, { startedAt: 'invalid', secretRealmCompletedAt },
    { startedAt, secretRealmCompletedAt: '' }, { startedAt, secretRealmCompletedAt: 'invalid' }]) {
    assert.equal(getDailyMilestoneAt(value), null);
  }
});
