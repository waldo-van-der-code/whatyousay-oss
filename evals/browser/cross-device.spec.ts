import { test, expect } from '@playwright/test';

test.describe('C — Cross-device auth link', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('/api/whatsapp/status', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true }),
      });
    });
    await page.route('/api/whatsapp/qr', async route => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: 'event: connected\ndata: {"connected":true}\n\n',
      });
    });
  });

  test('C01 POST /auth/link returns a URL with /auth/verify path', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);

    const res = await page.request.post('/auth/link');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.url).toMatch(/\/auth\/verify\?token=/);
  });
});
