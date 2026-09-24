/** Public messages are selected by code; Redis exception text is never trusted. */
const taskFailureMessages = {
  queue_timeout: '服务器可用实例紧张，请稍后再试。',
  worker_clock_skew: '执行服务器时间与任务服务器不同步，请同步执行服务器系统时间后重新申请。',
  invalid_task_payload: '登录任务数据无效，无法开始执行，请重新申请。',
  invalid_task_timestamps: '登录任务时间信息无效，请重新申请。',
  configuration_error: '执行服务器配置异常，请联系管理员检查后重新申请。',
  emulator_start_failed: '模拟器启动失败，请稍后重新申请。',
  game_launch_failed: '游戏启动失败，请稍后重新申请。',
  qr_not_found: '未能获取登录二维码，请重新申请。',
  command_timeout: '模拟器操作超时，请稍后重新申请。',
  unexpected_error: '任务执行异常，请稍后重新申请。',
  login_timeout: '扫码登录等待超时，请重新申请。',
  login_failed: '未能确认游戏登录成功，请重新申请。',
  login_finish_timeout: '扫码授权已完成，但进入游戏超时，请重新申请。',
  login_finish_failed: '扫码授权已完成，但进入游戏失败，请重新申请。',
  daily_timeout: '日常任务执行超时，请查看执行日志。',
  daily_failed: '日常任务执行失败，请查看执行日志。',
  instance_cleanup_failed: '游戏环境清理失败，请联系管理员检查模拟器状态。',
} as const;
export type TaskFailureCode = keyof typeof taskFailureMessages;
export function knownTaskFailureCode(code: unknown): TaskFailureCode | undefined {
  return typeof code === 'string' && Object.hasOwn(taskFailureMessages, code) ? code as TaskFailureCode : undefined;
}
export function taskFailureMessage(code: unknown, fallback = '任务执行失败，请查看执行日志或重新申请。'): string {
  const known = knownTaskFailureCode(code);
  return known ? taskFailureMessages[known] : fallback;
}
export function loginFailure(code: unknown): { error: string; errorCode?: TaskFailureCode } {
  const known = knownTaskFailureCode(code);
  return { error: taskFailureMessage(known, '二维码生成失败，请重新申请。'), ...(known ? { errorCode: known } : {}) };
}
