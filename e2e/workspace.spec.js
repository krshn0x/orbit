import { test, expect } from '@playwright/test';

test('wallet creation, policy edit, request, approval, audit and responsive navigation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
  for (const name of ['Contributor payouts', 'Treasury reserve']) {
    await page.getByRole('button', { name: '＋ Create wallet', exact: true }).click();
    await page.getByLabel('Wallet name').fill(name);
    await page.getByRole('button', { name: 'Create wallet ↗', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('.wallet-name').filter({ hasText: name })).toBeVisible();
  }
  await page.locator('nav [data-view="wallets"]').click();
  const source = page.locator('.wallet-card').filter({ hasText: 'Contributor payouts' });
  const recipient = await page.locator('.wallet-card').filter({ hasText: 'Treasury reserve' }).locator('.address-line').textContent();
  await source.getByRole('button', { name: 'Policy', exact: true }).click();
  await page.getByLabel('Require approval above').fill('0.01');
  await page.getByLabel('Allowed recipients').fill(recipient);
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await source.getByRole('button', { name: 'Send ↗' }).click();
  await page.getByLabel('Recipient address').fill(recipient);
  await page.getByLabel('Amount in SOL').fill('0.05');
  await page.getByRole('button', { name: 'Request payment ↗' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('nav [data-view="approvals"]').click();
  await expect(page.locator('.review-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Approve ↗' }).click();
  await expect(page.getByText('All caught up', { exact: false })).toBeVisible();
  await page.locator('nav [data-view="payments"]').click();
  await expect(page.locator('.badge.simulated')).toHaveText('simulated');
  await page.locator('nav [data-view="activity"]').click();
  await expect(page.getByText('payment.simulated', { exact: true })).toBeVisible();
  await page.locator('nav [data-view="overview"]').click();
  await page.screenshot({ path: '.artifacts/overview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.artifacts/overview-mobile.png', fullPage: true });
  await page.locator('nav [data-view="policies"]').click();
  await expect(page.getByRole('heading', { name: 'Wallet policies', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
