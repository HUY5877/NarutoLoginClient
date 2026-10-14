import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_USER_OPTIONS, parseUserOptions } from '../src/shared/user-options.js';
import { isRunTask, parseRunEvents } from '../src/frontend/lib/task-run.js';

const at = '2026-10-13T00:00:00.000Z';
const task = { id: 'task', status: 'queued', createdAt: at, expiresAt: at };

test('用户设置默认全部刷取秘境，旧布尔值归一化为模式且不修改输入或默认值', () => {
  assert.deepEqual(DEFAULT_USER_OPTIONS, { equipmentStamina: true, secretRealmMode: 'all' });
  for (const [value, expected] of [
    [undefined, { equipmentStamina: true, secretRealmMode: 'all' }],
    [{}, { equipmentStamina: true, secretRealmMode: 'all' }],
    [{ equipmentStamina: false }, { equipmentStamina: false, secretRealmMode: 'all' }],
    [{ secretRealmOnce: true }, { equipmentStamina: true, secretRealmMode: 'once' }],
    [{ secretRealmOnce: false }, { equipmentStamina: true, secretRealmMode: 'all' }],
    [{ secretRealmMode: 'skip' }, { equipmentStamina: true, secretRealmMode: 'skip' }],
    [{ secretRealmMode: 'once', secretRealmOnce: true }, { equipmentStamina: true, secretRealmMode: 'once' }],
    [{ secretRealmMode: 'all', secretRealmOnce: false }, { equipmentStamina: true, secretRealmMode: 'all' }],
  ] as const) {
    const before = JSON.stringify(value);
    const parsed = parseUserOptions(value);
    assert.deepEqual(parsed, expected);
    assert.equal(JSON.stringify(value), before);
    assert.notEqual(parsed, value);
    assert.notEqual(parsed, DEFAULT_USER_OPTIONS);
  }
});

test('前后端共用解析保留体力开关和三种秘境模式，执行记录保留统一 JSON', () => {
  for (const equipmentStamina of [true, false]) for (const secretRealmMode of ['once', 'all', 'skip'] as const) {
    const userOptions = { equipmentStamina, secretRealmMode };
    assert.deepEqual(parseUserOptions(userOptions), userOptions);
    const selectedTask = { ...task, userOptions };
    assert.ok(isRunTask(selectedTask));
    const parsed = parseRunEvents({ task: selectedTask, run: null, logs: [], nextCursor: '0-0',
      hasMore: false, truncated: false }, task.id, '0-0');
    assert.deepEqual(parsed.task.userOptions, userOptions);
    assert.equal(Object.hasOwn(parsed.task.userOptions!, 'secretRealmOnce'), false);
  }
  assert.ok(isRunTask({ ...task, userOptions: { equipmentStamina: false } }));
  assert.ok(isRunTask(task));
});

test('非法秘境值和未知字段在共用解析与前端执行记录校验中被拒绝', () => {
  for (const userOptions of [null, [], 'true', true, { secretRealmOnce: 'false' }, { secretRealmOnce: 0 },
    { secretRealmOnce: null }, { secretRealmOnce: [] }, { secretRealmOnce: {} },
    { equipmentStamina: 'true', secretRealmOnce: false }, { secretRealmOnce: true, other: false },
    { secretRealmOnce: undefined }, { secretRealmMode: 'invalid' }, { secretRealmMode: '' },
    { secretRealmMode: true }, { secretRealmMode: 0 }, { secretRealmMode: null },
    { secretRealmMode: [] }, { secretRealmMode: {} }, { secretRealmMode: undefined },
    { secretRealmMode: 'skip', secretRealmOnce: true }, { secretRealmMode: 'skip', secretRealmOnce: false },
    { secretRealmMode: 'once', secretRealmOnce: false }, { secretRealmMode: 'all', secretRealmOnce: true },
    { secretRealmMode: 'once', secretRealmOnce: 'true' }]) {
    assert.equal(parseUserOptions(userOptions), null, JSON.stringify(userOptions));
    assert.equal(isRunTask({ ...task, userOptions }), false, JSON.stringify(userOptions));
    assert.throws(() => parseRunEvents({ task: { ...task, userOptions }, run: null, logs: [],
      nextCursor: '0-0', hasMore: false, truncated: false }, task.id, '0-0'));
  }
});
