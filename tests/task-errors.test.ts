import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownTaskFailureCode, loginFailure, taskFailureMessage } from '../src/shared/task-errors.js';

test('客户端和服务端共享固定失败原因映射，不直接展示任意工作进程字符串', () => {
  assert.equal(taskFailureMessage('worker_clock_skew'), '执行服务器时间与任务服务器不同步，请同步执行服务器系统时间后重新申请。');
  assert.equal(taskFailureMessage('invalid_task_payload'), '登录任务数据无效，无法开始执行，请重新申请。');
  assert.equal(taskFailureMessage('invalid_task_timestamps'), '登录任务时间信息无效，请重新申请。');
  assert.deepEqual(loginFailure('worker_clock_skew'), {
    errorCode: 'worker_clock_skew', error: '执行服务器时间与任务服务器不同步，请同步执行服务器系统时间后重新申请。',
  });
  for (const value of ['constructor', '__proto__', 'redis://private-secret@host', {}, null, undefined]) {
    assert.equal(knownTaskFailureCode(value), undefined);
    assert.deepEqual(loginFailure(value), { error: '二维码生成失败，请重新申请。' });
    assert.equal(taskFailureMessage(value), '任务执行失败，请查看执行日志或重新申请。');
  }
});
