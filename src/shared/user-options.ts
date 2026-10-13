/** All user-selected task options travel together in this JSON object. */
export interface UserOptions {
  equipmentStamina: boolean;
  secretRealmOnce: boolean;
}

export const DEFAULT_USER_OPTIONS: Readonly<UserOptions> = Object.freeze({ equipmentStamina: true, secretRealmOnce: false });

/** Missing options on older requests keep the original daily-task behavior. */
export function parseUserOptions(value: unknown): UserOptions | null {
  if (value === undefined) return { ...DEFAULT_USER_OPTIONS };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => key !== 'equipmentStamina' && key !== 'secretRealmOnce')) return null;
  const selected = value as Record<string, unknown>;
  const equipmentStamina = selected.equipmentStamina === undefined
    ? DEFAULT_USER_OPTIONS.equipmentStamina : selected.equipmentStamina;
  const secretRealmOnce = selected.secretRealmOnce === undefined
    ? DEFAULT_USER_OPTIONS.secretRealmOnce : selected.secretRealmOnce;
  return typeof equipmentStamina === 'boolean' && typeof secretRealmOnce === 'boolean'
    ? { equipmentStamina, secretRealmOnce } : null;
}
