import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_USER_OPTIONS, parseUserOptions } from '../src/shared/user-options.js';
import { isRunTask, parseRunEvents } from '../src/frontend/lib/task-run.js';

const at = '2026-10-13T00:00:00.000Z';
const task = { id: 'task', status: 'queued', createdAt: at, expiresAt: at };

test('用户设置兼容旧对象，秘境仅刷一次默认关闭，归一化不修改输入或默认值', () => {
  assert.deepEqual(DEFAULT_USER_OPTIONS, { equipmentStamina: true, secretRealmOnce: false });
  for (const [value, expected] of [
    [undefined, { equipmentStamina: true, secretRealmOnce: false }],
    [{}, { equipmentStamina: true, secretRealmOnce: false }],
    [{ equipmentStamina: false }, { equipmentStamina: false, secretRealmOnce: false }],
    [{ secretRealmOnce: true }, { equipmentStamina: true, secretRealmOnce: true }],
  ] as const) {
    const before = JSON.stringify(value);
    const parsed = parseUserOptions(value);
    assert.deepEqual(parsed, expected);
    assert.equal(JSON.stringify(value), before);
    assert.notEqual(parsed, value);
    assert.notEqual(parsed, DEFAULT_USER_OPTIONS);
  }
});

test('前后端共用解析保留两项布尔的四种组合，执行记录保留原 JSON', () => {
  for (const equipmentStamina of [true, false]) for (const secretRealmOnce of [true, false]) {
    const userOptions = { equipmentStamina, secretRealmOnce };
    assert.deepEqual(parseUserOptions(userOptions), userOptions);
    const selectedTask = { ...task, userOptions };
    assert.ok(isRunTask(selectedTask));
    const parsed = parseRunEvents({ task: selectedTask, run: null, logs: [], nextCursor: '0-0',
      hasMore: false, truncated: false }, task.id, '0-0');
    assert.deepEqual(parsed.task.userOptions, userOptions);
  }
  assert.ok(isRunTask({ ...task, userOptions: { equipmentStamina: false } }));
  assert.ok(isRunTask(task));
});

test('非法秘境值和未知字段在共用解析与前端执行记录校验中被拒绝', () => {
  for (const userOptions of [null, [], 'true', true, { secretRealmOnce: 'false' }, { secretRealmOnce: 0 },
    { secretRealmOnce: null }, { secretRealmOnce: [] }, { secretRealmOnce: {} },
    { equipmentStamina: 'true', secretRealmOnce: false }, { secretRealmOnce: true, other: false }]) {
    assert.equal(parseUserOptions(userOptions), null, JSON.stringify(userOptions));
    assert.equal(isRunTask({ ...task, userOptions }), false, JSON.stringify(userOptions));
    assert.throws(() => parseRunEvents({ task: { ...task, userOptions }, run: null, logs: [],
      nextCursor: '0-0', hasMore: false, truncated: false }, task.id, '0-0'));
  }
});
