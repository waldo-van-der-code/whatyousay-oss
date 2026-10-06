// Spawned by evals/shutdown.ts: one voice note in flight when the signal arrives.
import { installGracefulShutdown, trackInFlight } from '../../src/shutdown';

installGracefulShutdown({
  stopAccepting: () => console.log('MARK stop-accepting'),
  closeSessions: async () => console.log('MARK sessions-closed'),
});

trackInFlight(new Promise<void>(resolve => setTimeout(() => {
  console.log('MARK reply-sent');
  resolve();
}, 1500)));

setInterval(() => {}, 1000);
console.log('MARK ready');
