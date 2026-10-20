export const secretRealmModes = ['once', 'all', 'skip'] as const;
export type SecretRealmMode = typeof secretRealmModes[number];
export const mainTasks = ['daily', 'arena_weekly'] as const;
export type MainTask = typeof mainTasks[number];

/** All user-selected task options travel together in this JSON object. */
export interface UserOptions {
  mainTask?: MainTask;
  equipmentStamina: boolean;
  secretRealmMode: SecretRealmMode;
}

export const DEFAULT_USER_OPTIONS: Readonly<UserOptions> = Object.freeze({ equipmentStamina: true, secretRealmMode: 'all' });

export function getMainTask(options?: Pick<UserOptions, 'mainTask'> | null): MainTask {
  return options?.mainTask ?? 'daily';
}

/** Missing options on older requests keep the original daily-task behavior. */
export function parseUserOptions(value: unknown): UserOptions | null {
  if (value === undefined) return { ...DEFAULT_USER_OPTIONS };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => key !== 'mainTask' && key !== 'equipmentStamina' && key !== 'secretRealmMode' && key !== 'secretRealmOnce')) return null;
  const selected = value as Record<string, unknown>;
  const hasMainTask = Object.hasOwn(selected, 'mainTask');
  if (hasMainTask && (typeof selected.mainTask !== 'string' || !mainTasks.includes(selected.mainTask as MainTask))) return null;
  const equipmentStamina = selected.equipmentStamina === undefined
    ? DEFAULT_USER_OPTIONS.equipmentStamina : selected.equipmentStamina;
  if (typeof equipmentStamina !== 'boolean') return null;
  const hasMode = Object.hasOwn(selected, 'secretRealmMode');
  const hasLegacy = Object.hasOwn(selected, 'secretRealmOnce');
  if (hasLegacy && typeof selected.secretRealmOnce !== 'boolean') return null;
  const legacyMode = selected.secretRealmOnce === true ? 'once' : 'all';
  const mode = hasMode ? selected.secretRealmMode : hasLegacy ? legacyMode : DEFAULT_USER_OPTIONS.secretRealmMode;
  if (typeof mode !== 'string' || !secretRealmModes.includes(mode as SecretRealmMode)) return null;
  if (hasMode && hasLegacy && mode !== legacyMode) return null;
  return { equipmentStamina, secretRealmMode: mode as SecretRealmMode,
    ...(hasMainTask ? { mainTask: selected.mainTask as MainTask } : {}) };
}
