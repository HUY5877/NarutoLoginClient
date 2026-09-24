import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTaskProgress, hasGameAuthorization, selectProgressRun, type ProgressInput } from '../src/frontend/lib/task-progress';
import { emptyTaskRun, type RunStatus } from '../src/frontend/lib/task-run';
import type { Session } from '../src/frontend/hooks/use-login-session';

const at = '2026-09-24T01:00:00.000Z';
const session: Session = { id: 'new-task', status: 'queued', createdAt: at, expiresAt: '2026-09-24T01:02:00.000Z', simulation: true };
function input(status?: RunStatus, patch: Partial<ProgressInput> = {}): ProgressInput {
  return { phase: 'queued', session, qrReady: false,
    view: { ...emptyTaskRun(), task: session, run: status ? {
      taskId: session.id, status, updatedAt: at,
      startedAt: ['running_daily', 'completed'].includes(status) ? at : null,
      finishedAt: ['completed', 'failed'].includes(status) ? at : null,
    } : null }, ...patch };
}
const states = (value: ProgressInput) => deriveTaskProgress(value).steps.map(step => step.state);

test('right-side steps have three fixed titles and progress from submission through QR to script', () => {
  const fresh = input(undefined, { phase: 'idle', session: null, view: emptyTaskRun() });
  assert.deepEqual(deriveTaskProgress(fresh).steps.map(step => step.title), ['提交登录申请', '二维码获取状态', '执行脚本']);
  assert.deepEqual(states(fresh), ['pending', 'pending', 'pending']);
  assert.deepEqual(states({ ...fresh, phase: 'restoring', awaitingSubmission: true }), ['active', 'pending', 'pending']);
  assert.deepEqual(states(input()), ['completed', 'active', 'pending']);
  assert.deepEqual(states(input('preparing_qr')), ['completed', 'active', 'pending']);
  assert.deepEqual(states(input('waiting_scan')), ['completed', 'completed', 'pending']);
  assert.deepEqual(states(input('running_daily')), ['completed', 'completed', 'active']);
  assert.deepEqual(states(input('completed')), ['completed', 'completed', 'completed']);
  for (const status of ['preparing_qr', 'waiting_scan', 'running_daily', 'completed'] as const) {
    assert.deepEqual(deriveTaskProgress(input(status)).steps.map(step => step.title), deriveTaskProgress(fresh).steps.map(step => step.title));
  }
});

test('clock validation failure belongs to QR stage and preserves its safe reason after expiry and refresh', () => {
  const value = input('failed');
  value.view.run!.errorCode = 'worker_clock_skew';
  for (const phase of ['queued', 'failed', 'expired', 'idle'] as const) {
    const current = { ...value, phase, session: phase === 'idle' ? null : { ...session, status: phase === 'expired' ? 'expired' as const : 'failed' as const } };
    const result = deriveTaskProgress(current);
    assert.deepEqual(result.steps.map(step => step.state), ['completed', 'failed', 'pending']);
    assert.equal(result.steps[1].description, '执行服务器时间与任务服务器不同步，请同步执行服务器系统时间后重新申请。');
    assert.equal(result.summary, '二维码获取失败');
  }
});

test('daily execution and completion remain successful after QR expiry without another QR request', () => {
  for (const status of ['running_daily', 'completed'] as const) {
    for (const phase of ['expired', 'query_failed', 'idle'] as const) {
      const current = input(status, { phase, session: phase === 'idle' ? null : { ...session, status: 'expired' } });
      const result = deriveTaskProgress(current);
      assert.deepEqual(result.steps.map(step => step.state), ['completed', 'completed', status === 'completed' ? 'completed' : 'active']);
      assert.equal(result.summary, status === 'completed' ? '任务已完成' : '脚本执行中');
      assert.notEqual(result.tone, 'danger');
    }
  }
});

test('daily failure affects only script, while QR/login preparation failure does not claim script began', () => {
  const daily = input('failed');
  daily.view.run!.startedAt = at;
  daily.view.run!.errorCode = 'daily_failed';
  assert.deepEqual(states(daily), ['completed', 'completed', 'failed']);
  assert.equal(deriveTaskProgress(daily).summary, '脚本执行失败');
  const login = input('failed');
  login.view.run!.errorCode = 'login_timeout';
  assert.deepEqual(states(login), ['completed', 'failed', 'pending']);
  assert.match(deriveTaskProgress(login).steps[1].description, /扫码登录等待超时/);
});

test('mock completed run without daily startedAt never reports script completion', () => {
  const mock = input('completed');
  mock.view.run!.startedAt = null;
  const result = deriveTaskProgress(mock);
  assert.deepEqual(states(mock), ['completed', 'completed', 'pending']);
  assert.equal(result.summary, '模拟流程完成');
  assert.equal(result.steps[2].description, '本次未执行脚本');
});

test('previous task progress and logs cannot be associated with a new request or mismatched session', () => {
  const previous = input('running_daily');
  previous.view.task = { ...session, id: 'old-task' };
  previous.view.run!.taskId = 'old-task';
  previous.view.logs = [{ id: '1-0', time: at, level: 'INFO', message: 'old task log' }];
  assert.deepEqual(states(previous), ['completed', 'active', 'pending']);
  assert.deepEqual(selectProgressRun(previous), emptyTaskRun());
  for (const phase of ['restoring', 'submitting', 'query_failed'] as const) {
    const requesting = { ...previous, session: { ...session, id: 'old-task' }, phase, awaitingSubmission: true };
    assert.deepEqual(selectProgressRun(requesting), emptyTaskRun());
    assert.deepEqual(states(requesting), [phase === 'query_failed' ? 'pending' : 'active', 'pending', 'pending']);
    assert.equal(deriveTaskProgress(requesting).taskId, null);
  }
  const refreshed = { ...previous, phase: 'idle' as const, session: null };
  assert.equal(selectProgressRun(refreshed).logs[0].message, 'old task log');
  assert.equal(deriveTaskProgress(refreshed).summary, '脚本执行中');
});

test('QR readiness alone waits for confirmed scan and failed session reasons remain safe without run logs', () => {
  const ready = input(undefined, { phase: 'qr_ready', session: { ...session, status: 'qr_ready' }, qrReady: true });
  assert.deepEqual(states(ready), ['completed', 'completed', 'pending']);
  assert.equal(deriveTaskProgress(ready).summary, '等待扫码');
  const failed = input(undefined, { phase: 'failed', session: { ...session, status: 'failed', errorCode: 'worker_clock_skew', error: 'private secret' } });
  assert.deepEqual(states(failed), ['completed', 'failed', 'pending']);
  assert.doesNotMatch(JSON.stringify(deriveTaskProgress(failed)), /private secret/);
});

test('accepted sessions keep their associated run after immediate QR read failure or local expiry', () => {
  for (const phase of ['query_failed', 'expired'] as const) {
    const current = input('running_daily', { phase, awaitingSubmission: false });
    assert.equal(selectProgressRun(current).task?.id, session.id);
    assert.equal(deriveTaskProgress(current).summary, '脚本执行中');
    const freshExpired = input(undefined, { phase: 'expired', session: { ...session, status: 'expired' }, awaitingSubmission: false });
    assert.equal(deriveTaskProgress(freshExpired).steps[0].state, 'completed');
    assert.equal(deriveTaskProgress(freshExpired).steps[1].state, 'failed');
  }
});

test('a newly failed session reason takes precedence over a lagging nonterminal run snapshot', () => {
  const current = input('starting_emulator', { phase: 'failed',
    session: { ...session, status: 'failed', errorCode: 'worker_clock_skew' } });
  const result = deriveTaskProgress(current);
  assert.deepEqual(result.steps.map(step => step.state), ['completed', 'failed', 'pending']);
  assert.equal(result.steps[1].description, '执行服务器时间与任务服务器不同步，请同步执行服务器系统时间后重新申请。');
});

test('restored failed login without retained run data never appears to be preparing a new QR', () => {
  const current = input(undefined, { phase: 'idle', session: null,
    view: { ...emptyTaskRun(), task: { ...session, status: 'failed' }, unavailable: true } });
  assert.deepEqual(states(current), ['completed', 'failed', 'pending']);
  assert.equal(deriveTaskProgress(current).summary, '二维码获取失败');
});

test('confirmed authorization ends QR waiting before daily execution and survives the original QR deadline', () => {
  const finishing = input('finishing_login', { phase: 'expired', session: { ...session, status: 'expired' } });
  finishing.view.run!.authorizedAt = at;
  assert.equal(hasGameAuthorization(finishing.view.run), true);
  assert.deepEqual(states(finishing), ['completed', 'completed', 'active']);
  assert.equal(deriveTaskProgress(finishing).summary, '正在进入游戏');
  assert.equal(deriveTaskProgress({ ...finishing, phase: 'idle', session: null }).summary, '正在进入游戏');
  finishing.view.run!.status = 'failed';
  finishing.view.run!.errorCode = 'login_finish_timeout';
  assert.equal(hasGameAuthorization(finishing.view.run), true);
  assert.deepEqual(states(finishing), ['completed', 'completed', 'failed']);
  assert.equal(deriveTaskProgress(finishing).steps[2].description, '扫码授权已完成，但进入游戏超时，请重新申请。');
  assert.equal(hasGameAuthorization(input('waiting_scan').view.run), false);
  const mock = input('completed'); mock.view.run!.startedAt = null;
  assert.equal(hasGameAuthorization(mock.view.run), false);
  assert.equal(hasGameAuthorization(input('running_daily').view.run), true);
});
