export const loginTypes = ['android_qq', 'ios_qq', 'android_wechat', 'ios_wechat'] as const;
export type LoginType = typeof loginTypes[number];
export const DEFAULT_LOGIN_TYPE: LoginType = 'android_qq';
export const loginTypeLabels: Record<LoginType, string> = {
  android_qq: '安卓 QQ 区', ios_qq: 'iOS QQ 区', android_wechat: '安卓微信区', ios_wechat: 'iOS 微信区',
};

// Only an absent field belongs to the legacy Android QQ protocol.
export function parseLoginType(value: unknown): LoginType | null {
  if (value === undefined) return DEFAULT_LOGIN_TYPE;
  return typeof value === 'string' && loginTypes.includes(value as LoginType) ? value as LoginType : null;
}
export const loginScanApp = (type: LoginType) => type.endsWith('_wechat') ? '微信' : 'QQ';
