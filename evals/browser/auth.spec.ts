import { test, expect } from '@playwright/test';
import { seedSession, TEST_EMAIL } from '../helpers/seed-session.ts';

// Auth specs run without a session (override global storageState)
const noAuth = { storageState: { cookies: [], origins: [] } };

test.describe('@readonly A — Redirects & landing (unauthenticated)', () => {
  test.use(noAuth);

  test('A01 GET / unauthenticated → redirect to /login', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.url()).toContain('/login');
  });

  test('A03 GET /admin unauthenticated → redirect to /login', async ({ page }) => {
    const res = await page.goto('/admin');
    expect(res?.url()).toContain('/login');
  });

  test('A05 /login page has email input and submit button', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();
  });
});

test.describe('A02 — Logged-in redirect', () => {
  test('A02 GET /login while logged in → redirect to /', async ({ page }) => {
    await page.goto('/login');
    expect(page.url()).not.toContain('/login');
  });
});

test.describe('@readonly B — Magic-link & login UI', () => {
  test.use(noAuth);

  // delivered+…@resend.dev is Resend's test sink: the API call is real, no mail is
  // delivered and no bounce counts against the sending domain. Distinct +labels keep
  // each test under the 3-per-email login limit (ME-065).
  test('B01 POST /auth/login with valid email → { ok: true }', async ({ page }) => {
    const res = await page.request.post('/auth/login', {
      data: { email: 'delivered+b01@resend.dev' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('B — Login page shows success view after email submit', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'delivered+ui@resend.dev');
    await page.click('#submit-btn');
    await expect(page.locator('#success-view')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#form-view')).toBeHidden();
  });

  test('B — /login?error=invalid shows error message', async ({ page }) => {
    await page.goto('/login?error=invalid');
    await expect(page.locator('#error-msg')).toBeVisible();
    await expect(page.locator('#error-msg')).toContainText(/expired|invalid/i);
  });
});

test.describe('B07 — Logout', () => {
  // Its own session: logging out the shared storageState session deleted it for
  // every spec that runs after this file.
  test.use(noAuth);
  test('B07 POST /auth/logout clears session and redirects to /login', async ({ page, context }) => {
    const { token } = seedSession(TEST_EMAIL);
    await context.addCookies([{ name: 'session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login/);
  });
});
