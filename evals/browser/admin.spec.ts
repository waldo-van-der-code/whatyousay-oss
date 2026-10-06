import { test, expect } from '@playwright/test';

test.describe('I — Admin panel', () => {
  test('I01 Non-admin user cannot access /admin', async ({ page }) => {
    const response = await page.goto('/admin');
    // Either redirected away from /admin, or landed on / (not admin content)
    expect(page.url()).not.toContain('/admin');
    if (response) {
      expect([200, 302, 301]).toContain(response.status());
    }
  });
});
