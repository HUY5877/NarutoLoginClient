import assert from 'node:assert/strict';

export const drawerTrigger = page => page.getByRole('button', { name: '任务进度与记录', exact: true });
export const taskDrawer = page => page.getByRole('dialog', { name: '本次任务', exact: true });

export async function openDrawer(page) {
  if (!await taskDrawer(page).isVisible()) await drawerTrigger(page).click();
  await taskDrawer(page).waitFor();
  return taskDrawer(page);
}

export async function closeDrawer(page) {
  await page.keyboard.press('Escape');
  await taskDrawer(page).waitFor({ state: 'hidden' });
}

export async function expectLockedOptions(page, ...values) {
  const summary = page.getByLabel('本次任务配置', { exact: true });
  await summary.waitFor();
  for (const value of values) await summary.filter({ hasText: value }).waitFor();
  assert.equal(await page.getByRole('button', { name: '账号归属', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '秘境探险', exact: true }).isVisible(), false);
  assert.equal(await page.locator('input[aria-labelledby="equipment-stamina-label"]').isVisible(), false);
}
