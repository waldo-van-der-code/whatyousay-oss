import { test, expect } from '@playwright/test';

const noAuth = { storageState: { cookies: [], origins: [] } };

test.describe('J — Session security', () => {
  test('J01 Expired/invalid session cookie → redirected to /login', async ({
    page,
    context,
  }) => {
    // Start with no auth, add a fake/tampered cookie
    await context.clearCookies();
    await context.addCookies([
      {
        name: 'session',
        value: 'tampered00000000000000000000000000000000000000000000000000000000',
        domain: 'localhost',
        path: '/',
      },
    ]);

    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
