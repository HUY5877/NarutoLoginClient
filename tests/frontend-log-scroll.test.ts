import assert from 'node:assert/strict';
import test from 'node:test';
import { createBottomLogLoader } from '../src/frontend/lib/log-scroll';

const area = (scrollHeight = 1000, clientHeight = 200, scrollTop = 800) => ({ scrollHeight, clientHeight, scrollTop });
test('只有用户向下到底才读取，打开和程序追加滚动不自动拉完', () => {
  let calls = 0, now = 0;
  const handlers = createBottomLogLoader(() => { calls++; }, () => true, () => now);
  const currentTarget = area();
  handlers.onScroll({ currentTarget });
  assert.equal(calls, 0);
  handlers.onWheel({ currentTarget, deltaY: -10 });
  assert.equal(calls, 0);
  handlers.onWheel({ currentTarget, deltaY: 10 });
  assert.equal(calls, 1);
  now += 1000; currentTarget.scrollTop += 10; currentTarget.scrollHeight += 10;
  handlers.onScroll({ currentTarget });
  assert.equal(calls, 1, 'An append and automatic following cannot trigger the next page');
});
test('滚动到末尾读取，连续事件节流，空页后新的向下操作仍可读取', () => {
  let calls = 0, now = 0, allowed = true;
  const handlers = createBottomLogLoader(() => { calls++; }, () => allowed, () => now);
  const currentTarget = area(1000, 200, 100);
  handlers.onWheel({ currentTarget, deltaY: 900 });
  assert.equal(calls, 0);
  currentTarget.scrollTop = 800; handlers.onScroll({ currentTarget });
  assert.equal(calls, 1);
  handlers.onWheel({ currentTarget, deltaY: 10 }); handlers.onScroll({ currentTarget });
  assert.equal(calls, 1);
  now += 1000; handlers.onScroll({ currentTarget }); assert.equal(calls, 1);
  handlers.onWheel({ currentTarget, deltaY: 10 }); assert.equal(calls, 2);
  now += 1000; allowed = false;
  handlers.onWheel({ currentTarget, deltaY: 10 }); assert.equal(calls, 2);
});
test('没有滚动条时，触屏和键盘也能继续读取，向上操作不会读取', () => {
  let calls = 0, now = 0;
  const handlers = createBottomLogLoader(() => { calls++; }, () => true, () => now);
  const currentTarget = area(100, 200, 0);
  handlers.onTouchStart({ touches: [{ clientY: 200 }] });
  handlers.onTouchMove({ currentTarget, touches: [{ clientY: 100 }] }); assert.equal(calls, 1);
  now += 1000;
  handlers.onTouchMove({ currentTarget, touches: [{ clientY: 150 }] }); assert.equal(calls, 1);
  handlers.onKeyDown({ currentTarget, key: 'PageDown', shiftKey: false }); assert.equal(calls, 2);
  now += 1000;
  handlers.onKeyDown({ currentTarget, key: ' ', shiftKey: true }); assert.equal(calls, 2);
  handlers.onKeyDown({ currentTarget, key: 'End', shiftKey: false }); assert.equal(calls, 3);
});
