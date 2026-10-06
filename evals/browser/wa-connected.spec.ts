import { test, expect } from '@playwright/test';

// Regression WYS-01: WhatsApp already connected still showed the connect/QR screen.
// These tests mock the status and SSE APIs so we don't need a real WhatsApp session.

test.describe('E — Dashboard: WhatsApp already connected', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the status API to return connected: true
    await page.route('/api/whatsapp/status', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, phone: '4917612345678' }),
      });
    });

    // Mock the SSE endpoint to immediately emit a connected event
    await page.route('/api/whatsapp/qr', async route => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        },
        body: 'event: connected\ndata: {"connected":true,"phone":"4917612345678"}\n\n',
      });
    });
  });

  // Regression WYS-01: this is the exact scenario reported as broken
  test('E03 Dashboard does NOT show QR/connect screen when WhatsApp is connected', async ({
    page,
  }) => {
    await page.goto('/');
    // Wait for init() to call checkInitialStatus
    await page.waitForTimeout(500);

    const qrSection = page.locator('#wa-qr-section');
    const connectedSection = page.locator('#wa-connected-section');

    // QR section must be hidden
    await expect(qrSection).toBeHidden({ timeout: 3000 });
    // Connected section must be visible
    await expect(connectedSection).toBeVisible({ timeout: 3000 });
  });

  test('E04 Dashboard shows transcriptions section when WhatsApp is connected', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await expect(page.locator('.card').filter({ hasText: 'Recent transcriptions' })).toBeVisible();
  });

  test('E05 Dashboard shows settings accordion when WhatsApp is connected', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="settings-accordion"]')).toBeVisible();
  });

  test('E06 Dashboard shows authenticated user email in nav', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    const navEmail = page.locator('#nav-email');
    await expect(navEmail).toBeVisible();
    const text = await navEmail.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });
});
