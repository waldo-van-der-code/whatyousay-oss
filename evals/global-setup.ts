import { chromium } from '@playwright/test';
import { seedSession, TEST_EMAIL } from './helpers/seed-session.ts';

const STATE_PATH = 'evals/storageState.json';

export default async function globalSetup() {
  const { token } = seedSession(TEST_EMAIL);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'session',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await context.storageState({ path: STATE_PATH });
  await browser.close();
}
