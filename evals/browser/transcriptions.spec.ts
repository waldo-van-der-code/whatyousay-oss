import { test, expect } from '@playwright/test';

test.describe('G — Transcriptions UI', () => {
  test('G05 Empty transcription list shows empty-state message (not an error)', async ({
    page,
  }) => {
    await page.route('/api/transcriptions', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
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
        body: 'event: connected\ndata: {"connected":true}\n\n',
      });
    });

    await page.goto('/');
    await page.waitForTimeout(500);

    const empty = page.locator('.txn-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/no transcriptions/i);
  });

  test('G06 Transcription items render text content and timestamp', async ({ page }) => {
    const fakeRow = {
      id: 1,
      user_id: 1,
      from_jid: '4917612345678@s.whatsapp.net',
      from_name: 'Alice',
      duration_s: 8.5,
      language: 'en',
      transcript: 'Hello this is a test transcript.',
      summary: null,
      content_deleted: 0,
      input_tokens: 80,
      output_tokens: 20,
      created_at: new Date(Date.now() - 60000).toISOString().replace('Z', ''),
    };

    await page.route('/api/transcriptions', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([fakeRow]),
      });
    });
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

    await page.goto('/');
    await page.waitForTimeout(600);

    const item = page.locator('.txn-item').first();
    await expect(item).toBeVisible();
    await expect(item).toContainText('Hello this is a test transcript.');
    await expect(item).toContainText('Alice');
    // Time badge
    await expect(item.locator('.txn-time')).toBeVisible();
  });

  // Regression ME-065: rows older than 90 days carry an "anon:" hash in from_jid and
  // a NULL from_name. The dashboard must label them, not print the hash or crash.
  test('G07 Regression ME-065: anonymised rows show "Anonymised sender", never the hash', async ({ page }) => {
    const base = {
      user_id: 1, duration_s: 8.5, language: 'de', transcript: null, summary: null,
      content_deleted: 1, input_tokens: 80, output_tokens: 20,
    };
    const rows = [
      { ...base, id: 2, from_jid: '4917612345678@s.whatsapp.net', from_name: 'Alice',
        created_at: new Date(Date.now() - 60000).toISOString().replace('Z', '') },
      { ...base, id: 1, from_jid: 'anon:0123456789abcdef0123456789abcdef', from_name: null,
        created_at: new Date(Date.now() - 100 * 86400000).toISOString().replace('Z', '') },
    ];
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('/api/transcriptions', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }));
    await page.route('/api/whatsapp/status', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: true }) }));
    await page.route('/api/whatsapp/qr', route =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: 'event: connected\ndata: {"connected":true}\n\n',
      }));

    await page.goto('/');
    const items = page.locator('.txn-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator('.txn-from')).toContainText('Alice');
    await expect(items.nth(1).locator('.txn-from')).toHaveText('From: Anonymised sender');
    await expect(page.locator('#txn-list')).not.toContainText('0123456789abcdef');
    await expect(items.nth(1)).toContainText('8s');
    expect(errors).toEqual([]);
  });
});
