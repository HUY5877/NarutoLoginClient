import type { Phase, Session } from '../hooks/use-login-session';
import { emptyTaskRun, type TaskRun, type TaskRunView } from './task-run';
import { taskFailureMessage } from '../../shared/task-errors';
import { DEFAULT_LOGIN_TYPE, loginScanApp } from '../../shared/login-types';
import { deriveDailyCompletion } from './daily-completion';
import { getMainTask, type MainTask } from '../../shared/user-options';
import { mainTaskFailureMessage } from './main-task';

export type StepState = 'pending' | 'active' | 'completed' | 'failed';
export interface ProgressStep {
  id: 'submission' | 'qr' | 'script';
  title: string;
  description: string;
  state: StepState;
}
export interface ProgressInput {
  phase: Phase;
  session: Session | null;
  qrReady: boolean;
  view: TaskRunView;
  awaitingSubmission?: boolean;
  mainTask?: MainTask;
}
export function hasGameAuthorization(run: TaskRun | null): boolean {
  return Boolean(run && (run.authorizedAt || run.startedAt || ['finishing_login', 'running_daily'].includes(run.status)));
}
export function isUnclaimedQueueTimeout(session: Session | null, run: TaskRun | null): boolean {
  // A claimed snapshot overrides a stale queue timeout; an authoritative queued
  // run may itself expire before a worker ever starts it.
  return session?.status === 'expired' && session.errorCode === 'queue_timeout'
    && (!run || run.taskId !== session.id || run.status === 'expired' && run.errorCode === 'queue_timeout');
}
export function selectProgressRun({ phase, session, view, awaitingSubmission }: ProgressInput): TaskRunView {
  // A previous task may still be polling while the user submits another request.
  // Wait for that request's identity before associating execution logs with it.
  if (awaitingSubmission || phase === 'restoring' || phase === 'submitting'
    || session && view.task?.id !== session.id) return emptyTaskRun();
  return view;
}
export function hasCapturedScan(input: ProgressInput): boolean {
  if (input.awaitingSubmission || ['restoring', 'submitting'].includes(input.phase)) return false;
  const view = selectProgressRun(input);
  return input.session?.scanCaptured === true
    || Boolean(view.run?.scanCapturedAt && view.run.taskId === view.task?.id);
}
export function deriveTaskProgress(input: ProgressInput) {
  const { phase, qrReady, awaitingSubmission } = input;
  const resolving = phase === 'restoring' || phase === 'submitting';
  const view = selectProgressRun(input);
  const session = resolving || awaitingSubmission ? null : input.session;
  const task = session ?? view.task;
  const run = view.run && view.task?.id === view.run.taskId ? view.run : null;
  const mainTask = view.task ? getMainTask(view.task.userOptions)
    : session ? getMainTask(session.userOptions) : input.mainTask ?? 'daily';
  const arena = mainTask === 'arena_weekly';
  const taskName = arena ? '决斗场周胜任务' : '日常任务';
  const steps: ProgressStep[] = [
    { id: 'submission', title: '申请任务', state: task ? 'completed' : resolving ? 'active' : 'pending',
      description: task ? '申请已提交' : resolving ? phase === 'submitting' ? '正在提交申请' : '正在查询已有申请'
        : phase === 'query_failed' ? '正在等待确认申请状态' : '点击「获取授权二维码」提交申请' },
    { id: 'qr', title: '获取二维码', state: 'pending', description: '等待提交申请' },
    { id: 'script', title: '执行任务', state: 'pending', description: `登录游戏后执行${taskName}` },
  ];
  let summary = task ? '获取二维码中' : resolving ? '提交中' : phase === 'query_failed' ? '待确认' : '待开始';
  let tone: 'default' | 'success' | 'danger' = 'default';
  let hint = '点击「获取授权二维码」提交申请。';
  if (!task) {
    if (phase === 'expired') {
      steps[0].state = 'failed'; steps[0].description = '本次申请确认已超时，请重新申请';
      summary = '申请确认超时'; tone = 'danger'; hint = '重新操作时会先检查服务器上的有效申请。';
    }
    return { steps, summary, tone, hint, taskId: null, mainTask };
  }

  const [submission, qr, script] = steps;
  submission.state = 'completed';
  const scriptStarted = Boolean(run?.startedAt) || run?.status === 'running_daily';
  const initialCompletion = deriveDailyCompletion(run, view.task?.userOptions);
  if (hasGameAuthorization(run) && run) {
    qr.state = 'completed';
    qr.description = '扫码登录已确认';
    if (run.status === 'completed') {
      script.state = 'completed';
      script.description = arena ? '本次周胜已完成' : '本次日常已完成';
      summary = '任务已完成'; tone = 'success'; hint = script.description;
    } else if (initialCompletion) {
      script.state = initialCompletion.state;
      script.description = initialCompletion.description;
      summary = initialCompletion.summary; tone = initialCompletion.tone; hint = initialCompletion.description;
    } else if (['failed', 'interrupted', 'expired'].includes(run.status)) {
      script.state = 'failed';
      script.description = mainTaskFailureMessage(mainTask, run.errorCode,
        run.status === 'interrupted' ? '脚本执行已中断，请查看下方执行记录。' : '脚本执行失败，请查看下方执行记录。');
      summary = arena ? '周胜任务执行失败' : '脚本执行失败'; tone = 'danger'; hint = script.description;
    } else if (!scriptStarted) {
      script.state = 'active';
      script.description = `正在进入游戏，准备执行${taskName}`;
      summary = '正在进入游戏'; hint = arena ? '授权已经完成，无需再次扫码；进入游戏后继续执行周胜任务。' : '授权已经完成，无需再次扫码；进入游戏后继续执行日常。';
    } else {
      script.state = 'active';
      script.description = `正在执行${taskName}`;
      summary = arena ? '周胜任务执行中' : '脚本执行中'; hint = `二维码到期不影响已经开始的${taskName}。`;
    }
    return { steps, summary, tone, hint, taskId: task.id, mainTask };
  }

  if (phase === 'login_confirmed' || session?.loginAuthorized) {
    qr.state = 'completed'; qr.description = '扫码登录已确认';
    script.state = 'active'; script.description = arena ? '正在进入游戏并准备执行周胜任务' : '正在进入游戏并准备执行日常';
    summary = '正在进入游戏'; hint = '授权已经完成，无需再次扫码。';
  } else if (hasCapturedScan(input)) {
    qr.state = 'completed'; qr.description = '已收到扫码结果';
    const failed = run && ['failed', 'interrupted', 'expired'].includes(run.status)
      || ['failed', 'expired'].includes(task.status) || ['failed', 'expired'].includes(phase);
    if (failed) {
      script.state = 'failed';
      summary = run?.status === 'expired' || phase === 'expired' || task.status === 'expired' ? '游戏登录超时' : '游戏登录未完成';
      script.description = '扫码已完成，但游戏登录未完成，脚本尚未开始，请重新申请。';
      tone = 'danger'; hint = script.description;
    } else {
      script.description = '正在登录游戏';
      summary = '扫码成功'; hint = '已收到扫码结果，正在登录游戏。';
    }
  } else if (isUnclaimedQueueTimeout(session, run)) {
    qr.state = 'failed'; qr.description = taskFailureMessage('queue_timeout');
    script.description = '申请排队超时，脚本尚未开始';
    summary = '排队超时'; tone = 'danger'; hint = qr.description;
  } else if (run?.status === 'completed') {
    // The mock worker completes QR generation without ever starting a daily script.
    qr.state = 'completed'; qr.description = '二维码生成流程已完成';
    script.description = '仅生成二维码，未执行游戏任务';
    summary = '模拟流程完成'; tone = 'success'; hint = script.description;
  } else if (run && ['failed', 'interrupted', 'expired'].includes(run.status) || task.status === 'failed' || phase === 'failed') {
    qr.state = 'failed';
    const terminalRun = run && ['failed', 'interrupted', 'expired'].includes(run.status) ? run : null;
    const errorCode = terminalRun?.errorCode ?? (session?.status === 'failed' ? session.errorCode : undefined);
    qr.description = terminalRun ? mainTaskFailureMessage(mainTask, errorCode,
      terminalRun.status === 'expired' ? '等待扫码登录已超时，请重新申请。' : '二维码获取或登录确认失败，请重新申请。')
      : mainTaskFailureMessage(mainTask, errorCode, '二维码生成失败，请重新申请。');
    script.description = '登录准备未完成，脚本尚未开始';
    summary = '二维码获取失败'; tone = 'danger'; hint = qr.description;
  } else if (phase === 'query_failed' && session) {
    qr.description = '二维码状态尚未确认';
    summary = '待确认'; hint = '连接恢复后可继续查询已有申请。';
  } else if (phase === 'expired' || task.status === 'expired') {
    qr.state = 'failed'; qr.description = '二维码已过期，请重新申请';
    script.description = '尚未确认扫码登录，脚本未开始';
    summary = '等待登录超时'; tone = 'danger'; hint = '再次点击生成二维码时，会先检查已有申请。';
  } else if (session?.refreshRequestId) {
    qr.state = 'active'; qr.description = '正在当前模拟器中刷新二维码';
    script.description = '等待扫码登录，登录成功后开始执行';
    summary = '刷新二维码'; hint = '新二维码上传完成后会自动显示，实例占用期限保持不变。';
  } else if (qrReady || run?.status === 'waiting_scan' || task.status === 'qr_ready') {
    qr.state = 'completed';
    const scanApp = loginScanApp(task.loginType ?? DEFAULT_LOGIN_TYPE);
    qr.description = qrReady ? (scanApp === 'QQ' ? '用手机 QQ 扫码' : '用手机微信扫码') : '二维码已生成';
    script.description = `登录游戏后执行${taskName}`;
    summary = '等待扫码'; hint = '扫码登录成功后，第三阶段会显示脚本执行进度。';
  } else {
    qr.state = 'active';
    qr.description = task.status === 'queued' && (!run || run.status === 'queued') ? '等待空闲服务器'
      : run?.status === 'opening_game' || task.status === 'opening_game' ? '正在打开游戏并准备登录'
        : run?.status === 'preparing_qr' || task.status === 'preparing_qr' ? '正在获取登录二维码'
          : '正在准备游戏环境并获取二维码';
    hint = '二维码准备好后会显示；登录成功后继续执行脚本。';
  }
  return { steps, summary, tone, hint, taskId: task.id, mainTask };
}
