import { cleanupTestUser, TEST_EMAIL } from './helpers/seed-session.ts';

export default async function globalTeardown() {
  cleanupTestUser(TEST_EMAIL);
}
