import { test, expect, Page } from '@playwright/test';
import {
  TEST_EMAIL,
  userIdFor,
  seedTelegramGroup,
  seedUser,
  seedSession,
  cleanupTestUser,
  deleteSession,
  setLinkCode,
} from '../helpers/seed-session.ts';

// Telegram group titles are chosen by whoever creates the group, and before ME-065 the
// bot accepted forged webhook updates — so a title is attacker-controlled text.
const TITLE_PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">Evil group';
// chat_id reached an inline onclick='removeTgGroup(...)' before ME-065.
const CHAT_ID_PAYLOAD = "-100');window.__xss2=1;//";
// A syntactically valid address (WHATWG rules allow ' and `) that broke out of the
// admin page's onclick="deleteUser(id,'…')" attribute: escHtml did not escape '.
const ADMIN_EMAIL_PAYLOAD = "x'-alert`1`-'@evil.com";

async function mockWhatsApp(page: Page) {
  // avatarUrl points at WhatsApp's CDN so the CSP check exercises img-src too.
  const status = { connected: true, phone: '4917612345678', avatarUrl: 'https://pps.whatsapp.net/v/t61/eval.jpg' };
  await page.route('/api/whatsapp/status*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }),
  );
  await page.route('/api/whatsapp/qr', route =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: 'event: connected\ndata: {"connected":true}\n\n',
    }),
  );
}

async function trackScriptSignals(page: Page) {
  const dialogs: { type: string; message: string }[] = [];
  page.on('dialog', d => {
    dialogs.push({ type: d.type(), message: d.message() });
    d.dismiss().catch(() => {});
  });
  await page.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', e => {
      (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return dialogs;
}

test.describe('ME-065 — stored XSS', () => {
  test('Regression ME-065: a Telegram group title with an <img onerror> payload renders as text and runs no script', async ({ page }) => {
    const userId = userIdFor(TEST_EMAIL);
    expect(userId, 'test user must exist (global-setup)').not.toBeNull();
    seedTelegramGroup(userId!, '-1009990001', TITLE_PAYLOAD);
    seedTelegramGroup(userId!, CHAT_ID_PAYLOAD, 'Plain group');

    await mockWhatsApp(page);
    const dialogs = await trackScriptSignals(page);
    await page.goto('/');

    const list = page.locator('#tg-groups-list');
    await expect(list).toContainText(TITLE_PAYLOAD);
    await expect(list.locator('img')).toHaveCount(0);
    await page.waitForTimeout(300); // give a broken image's onerror time to fire
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

    // Remove the group whose chat_id carries the payload: the click must not execute it,
    // and the DELETE must still hit the right row.
    const row = list.locator('div', { hasText: 'Plain group' }).last();
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(list).not.toContainText('Plain group');
    expect(await page.evaluate(() => (window as any).__xss2)).toBeUndefined();
    await expect(list).toContainText(TITLE_PAYLOAD); // the other group is untouched
    expect(dialogs.filter(d => d.type === 'alert')).toEqual([]);
  });

  test('Regression ME-065: dashboard sends a CSP and loads with no policy violations', async ({ page }) => {
    await mockWhatsApp(page);
    await trackScriptSignals(page);
    const res = await page.goto('/');
    const csp = res?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    await expect(page.locator('#tg-section')).toBeVisible();
    await page.waitForTimeout(1500); // let libphonenumber load
    expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
    // Prove the third-party script actually ran, not merely that nothing was reported.
    expect(await page.evaluate(() => typeof (window as any).libphonenumber)).toBe('object');
  });

  test('Regression ME-065: the dashboard shows the new single-use link code when the user returns', async ({ page }) => {
    await mockWhatsApp(page);
    await page.goto('/');
    const cmd = page.locator('#tg-link-command');
    await expect(cmd).toHaveText(/^\/link [0-9A-F]{32}$/);
    const fresh = 'F'.repeat(32);
    setLinkCode(userIdFor(TEST_EMAIL)!, fresh); // what /link does in Telegram
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(cmd).toHaveText(`/link ${fresh}`);
  });

  test.describe('admin panel', () => {
    const adminEmail = process.env.ADMIN_EMAIL ?? '';
    test.skip(!adminEmail, 'ADMIN_EMAIL not set — admin checks need the server and test to share it');

    // Never delete the admin account itself: ADMIN_EMAIL may be a real user in DB_PATH.
    let createdAdmin = false;
    let adminToken = '';
    test.afterAll(() => {
      cleanupTestUser(ADMIN_EMAIL_PAYLOAD);
      if (createdAdmin) cleanupTestUser(adminEmail);
      else if (adminToken) deleteSession(adminToken);
    });

    test('Regression ME-065: an email with a quote payload cannot break out of the Delete button', async ({ browser, baseURL }) => {
      seedUser(ADMIN_EMAIL_PAYLOAD);
      createdAdmin = userIdFor(adminEmail) === null;
      const { token } = seedSession(adminEmail);
      adminToken = token;
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      await context.addCookies([{ name: 'session', value: token, url: baseURL! }]);
      const page = await context.newPage();
      const dialogs = await trackScriptSignals(page);

      await page.goto('/admin');
      const row = page.locator('tr', { hasText: ADMIN_EMAIL_PAYLOAD });
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').first()).toHaveText(ADMIN_EMAIL_PAYLOAD);

      await row.getByRole('button', { name: 'Delete' }).click();
      await expect.poll(() => dialogs.length).toBeGreaterThan(0);
      await page.waitForTimeout(200);

      expect(dialogs.filter(d => d.type === 'alert')).toEqual([]);
      expect(dialogs[0].type).toBe('confirm');
      expect(dialogs[0].message).toContain(ADMIN_EMAIL_PAYLOAD);
      // Confirm was dismissed, so the user must still be there.
      await expect(row).toHaveCount(1);
      await context.close();
    });
  });
});
