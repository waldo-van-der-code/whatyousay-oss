import { test, expect } from '@playwright/test';

test.describe('D — Dashboard: WhatsApp not connected', () => {
  test.beforeEach(async ({ page }) => {
    // Mock status: not connected
    await page.route('/api/whatsapp/status', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: false }),
      });
    });

    // Mock SSE: stay silent (no events — simulates waiting for QR)
    await page.route('/api/whatsapp/qr', async route => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: '',
      });
    });
  });

  test('D02 Dashboard shows connect/QR section when not connected', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await expect(page.locator('#wa-qr-section')).toBeVisible();
  });

  test('D03 Dashboard does NOT show connected section when not connected', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await expect(page.locator('#wa-connected-section')).toBeHidden();
  });
});

test.describe('F03 — Disconnect reverts to connect screen', () => {
  test('F03 After disconnecting, dashboard reverts to QR/connect screen', async ({ page }) => {
    // Start connected
    await page.route('/api/whatsapp/status', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, phone: '4917612345678' }),
      });
    });
    await page.route('/api/whatsapp/qr', async route => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: 'event: connected\ndata: {"connected":true,"phone":"4917612345678"}\n\n',
      });
    });

    await page.goto('/');
    await expect(page.locator('#wa-connected-section')).toBeVisible({ timeout: 3000 });

    // Now mock disconnect response and SSE to fire 'disconnected'
    await page.unroute('/api/whatsapp/qr');
    await page.route('/api/whatsapp/disconnect', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.route('/api/whatsapp/qr', async route => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: 'event: disconnected\ndata: {}\n\n',
      });
    });

    // Trigger disconnect (confirm dialog)
    page.on('dialog', d => d.accept());
    await page.click('button.btn-danger');

    await expect(page.locator('#wa-qr-section')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#wa-connected-section')).toBeHidden();
  });
});
