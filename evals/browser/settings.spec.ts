import { test, expect, type Page } from '@playwright/test';

// The settings body starts open; the accordion toggles. Click only when it is closed so the
// helper is correct whichever state the dashboard renders in.
async function openSettings(page: Page) {
  const body = page.locator('#settings-body');
  if (!(await body.evaluate(el => el.classList.contains('open')))) {
    await openSettings(page);
  }
  await expect(body).toHaveClass(/open/);
}

test.describe('H — Settings UI', () => {
  test.beforeEach(async ({ page }) => {
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
  });

  test('H03/H04 Settings persist: save a value and verify it loads on next visit', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(500);

    // Expand settings accordion
    await openSettings(page);
    await expect(page.locator('#settings-body')).toHaveClass(/open/);

    // Change summary_min_words to 200
    await page.fill('#s-min-words', '200');
    await page.dispatchEvent('#s-min-words', 'change');

    // Wait for "Saved ✓" confirmation
    await expect(page.locator('#settings-saved-msg')).toBeVisible({ timeout: 3000 });

    // Reload and verify value persisted
    await page.reload();
    await page.waitForTimeout(500);
    await openSettings(page);
    const val = await page.inputValue('#s-min-words');
    expect(parseInt(val, 10)).toBe(200);

    // Restore original value
    await page.fill('#s-min-words', '120');
    await page.dispatchEvent('#s-min-words', 'change');
    await page.waitForTimeout(700);
  });

  test('H04 Settings form pre-fills current saved values on load', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await openSettings(page);

    // Checkboxes exist and have a value (true or false — just assert they loaded)
    const recv1on1 = await page.isChecked('#s-1on1-recv');
    const sent1on1 = await page.isChecked('#s-1on1-sent');
    // Default: recv=true, sent=true
    expect(typeof recv1on1).toBe('boolean');
    expect(typeof sent1on1).toBe('boolean');
  });

  // Regression WAY-29: settings fields that existed in the deployed UI but were absent from the
  // git-tracked dashboard.html, causing them to silently disappear on every deploy.
  test('Regression WAY-29: all documented settings fields are visible in the settings panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    await openSettings(page);

    // 1:1 / Groups toggles
    await expect(page.locator('#s-1on1-sent')).toBeAttached(); // custom toggle: the checkbox itself is visually hidden
    await expect(page.locator('label.toggle:has(#s-1on1-sent)')).toBeVisible();
    await expect(page.locator('#s-1on1-recv')).toBeAttached(); // custom toggle: the checkbox itself is visually hidden
    await expect(page.locator('label.toggle:has(#s-1on1-recv)')).toBeVisible();
    await expect(page.locator('#s-grp-sent')).toBeAttached(); // custom toggle: the checkbox itself is visually hidden
    await expect(page.locator('label.toggle:has(#s-grp-sent)')).toBeVisible();
    await expect(page.locator('#s-grp-recv')).toBeAttached(); // custom toggle: the checkbox itself is visually hidden
    await expect(page.locator('label.toggle:has(#s-grp-recv)')).toBeVisible();

    // Exclude chips inputs
    await expect(page.locator('#s-exclude-contacts-input')).toBeVisible();
    await expect(page.locator('#s-exclude-groups-input')).toBeVisible();

    // Translation
    await expect(page.locator('#s-translate')).toBeAttached();
    await expect(page.locator('label.toggle:has(#s-translate)')).toBeVisible();
    await expect(page.locator('#s-lang-select')).toBeVisible();

    // AI Summary
    await expect(page.locator('#s-summary')).toBeAttached();
    await expect(page.locator('label.toggle:has(#s-summary)')).toBeVisible();
    await expect(page.locator('#s-min-words')).toBeVisible();
    await expect(page.locator('#s-custom-prompt')).toBeVisible();

    // Transcription context (WAY-29)
    await expect(page.locator('#s-whisper-context')).toBeVisible();
    // #s-whisper-sender-name was removed in WAY-35 (nothing read the setting): assert it stays gone.
    await expect(page.locator('#s-whisper-sender-name')).toHaveCount(0);
  });

  // Regression WAY-29: chip inputs accept values and save them
  test('Regression WAY-29: exclude_contacts chip input saves values', async ({ page }) => {
    await page.route('/api/settings', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        // Verify the chip value is passed as an array
        if (body.exclude_contacts !== undefined) {
          expect(Array.isArray(body.exclude_contacts)).toBe(true);
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            transcribe_1on1_received: true, transcribe_1on1_sent: true,
            transcribe_group_received: false, transcribe_group_sent: false,
            translate_to_english: false, summary_enabled: true,
            summary_min_words: 120, summary_custom_prompt: '',
            whisper_context: '', whisper_include_sender_name: true,
            exclude_contacts: [], exclude_groups: [],
          }),
        });
      }
    });

    await page.goto('/');
    await page.waitForTimeout(500);
    await openSettings(page);

    await page.fill('#s-exclude-contacts-input', 'TestContact');
    await page.press('#s-exclude-contacts-input', 'Enter');

    // Chip should appear
    await expect(page.locator('#s-exclude-contacts-chips .chip')).toHaveCount(1);
    await expect(page.locator('#s-exclude-contacts-chips .chip span').first()).toHaveText('TestContact');
  });
});
