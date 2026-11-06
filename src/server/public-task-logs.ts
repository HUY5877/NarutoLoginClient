// Apply at read time too: old Redis streams and SLS archives still contain
// implementation diagnostics written before the worker's public-log boundary.
const privateTaskText = [
  /抓号|扫号器|上号器/,
  /qq[_-]?(?:capture|automation|apk)|qq自动化/i,
  /qq_authorizations/i,
  /capture(?:configurationerror|error|store|round|session)|capture[_-]?(?:apps?|applications?|package|marker|round|provider|callback)|apk/i,
  /helper(?:apps?|applications?|installation)|missinghelpers/i,
  /huy(?:capture|login|automation)|com\.huy\.(?:authcapture|authlogin)|com\.tencent\.tim/i,
  /automationprovider|call[_-]?back[_-]?url|回调地址/i,
  /(?:qq|自动化|授权).*(?:provider|callback)|(?:provider|callback).*(?:qq|自动化|授权)/i,
  /临时授权|本轮授权|授权轮次|授权交接|授权注入|注入授权|授权回调/,
  /辅助(?:应用|软件|工具|apk)|自动补装/i,
  /游戏恢复到开始游戏页，返回重新选择本次登录通道|识别到之前的QQ扫码授权页，返回游戏重新选择本次登录通道/,
  /已点击本次指定登录通道[：:](?:android|ios)_qq/i,
];

function isPrivateTaskText(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return privateTaskText.some(pattern => pattern.test(compact));
}

export function isPublicTaskLog(log: { message: string }): boolean {
  return !isPrivateTaskText(log.message);
}

// Only the response projection changes; never write this value back to a run.
export function publicTaskErrorCode(code: string): string {
  return isPrivateTaskText(code) ? 'unexpected_error' : code;
}
