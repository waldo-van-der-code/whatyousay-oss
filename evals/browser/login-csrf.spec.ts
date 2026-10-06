import { test, expect } from '@playwright/test';
import { seedLoginToken, cleanupTestUser, userIdFor } from '../helpers/seed-session.ts';

// Regression ME-065: GET /auth/verify logged in whoever opened the link, so an
// attacker could mail or embed their own link and log a victim into the attacker's
// account. The link now opens a confirm page naming the account; only its POST logs in.

const noAuth = { storageState: { cookies: [], origins: [] } };
const LINK_EMAIL = 'csrf-eval@whatyousay.local';

test.describe('V — Magic-link confirm page', () => {
  test.use(noAuth);
  test.afterAll(() => cleanupTestUser(LINK_EMAIL));

  test('V01 Regression ME-065: opening a link shows the account and does not log in until confirmed', async ({ page, context }) => {
    const token = seedLoginToken(LINK_EMAIL);
    await page.goto(`/auth/verify?token=${token}`);
    await expect(page.locator('#verify-email')).toHaveText(LINK_EMAIL);
    await expect(page.getByText(/different browser or device/i)).toBeVisible();
    expect((await context.cookies()).some(c => c.name === 'session')).toBe(false);
    expect(userIdFor(LINK_EMAIL)).toBeNull();

    await page.click('#confirm-btn');
    await expect(page).toHaveURL(/\/$/);
    const session = (await context.cookies()).find(c => c.name === 'session');
    expect(session?.httpOnly).toBe(true);
    expect(userIdFor(LINK_EMAIL)).not.toBeNull();
  });

  test('V02 Regression ME-065: the browser that requested the link sees no warning', async ({ page, context }) => {
    const nonce = 'a'.repeat(64);
    await context.addCookies([{ name: 'login_nonce', value: nonce, domain: 'localhost', path: '/auth', httpOnly: true, sameSite: 'Lax' }]);
    const token = seedLoginToken(LINK_EMAIL, nonce);
    await page.goto(`/auth/verify?token=${token}`);
    await expect(page.locator('#verify-email')).toHaveText(LINK_EMAIL);
    await expect(page.getByText(/different browser or device/i)).toHaveCount(0);
  });

  test('V03 Regression ME-065: a form on another site cannot submit the confirm', async ({ page, context }) => {
    const token = seedLoginToken(LINK_EMAIL);
    const target = new URL('/auth/verify', test.info().project.use.baseURL ?? 'http://localhost:3000').toString();
    await page.route('http://evil.test/', route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<form id="f" method="POST" action="${target}"><input name="token" value="${token}"></form>`,
      })
    );
    await page.goto('http://evil.test/');
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().startsWith(target)),
      page.evaluate(() => (document.getElementById('f') as HTMLFormElement).submit()),
    ]);
    expect(response.status()).toBe(403);
    expect((await context.cookies()).some(c => c.name === 'session')).toBe(false);

    // The rejected post did not burn the link.
    await page.goto(`/auth/verify?token=${token}`);
    await expect(page.locator('#verify-email')).toHaveText(LINK_EMAIL);
  });

  test('V04 Regression ME-065: an expired or unknown token goes back to the login page', async ({ page }) => {
    await page.goto(`/auth/verify?token=${'0'.repeat(64)}`);
    await expect(page).toHaveURL(/\/login\?error=invalid/);
  });
});

test.describe('V — Dashboard names the account', () => {
  test('V05 Regression ME-065: the account email is shown above the WhatsApp QR', async ({ page }) => {
    await page.route('/api/whatsapp/status', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) })
    );
    await page.route('/api/whatsapp/qr', route =>
      route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: '' })
    );
    await page.goto('/');
    await expect(page.locator('#wa-account-email')).toHaveText('test-eval@whatyousay.local');
    const emailBox = await page.locator('#wa-account-email').boundingBox();
    const qrBox = await page.locator('#wa-qr-container').boundingBox();
    expect(emailBox && qrBox && emailBox.y < qrBox.y).toBeTruthy();
  });
});
