import { logger } from './logger';

// Must stay below pm2's kill_timeout in ecosystem.config.js, or pm2 SIGKILLs mid-drain.
export const DRAIN_TIMEOUT_MS = 45_000;
const CLOSE_GRACE_MS = 5_000;

const inFlight = new Set<Promise<unknown>>();

export function trackInFlight(work: Promise<unknown>): void {
  inFlight.add(work);
  work
    .catch(err => logger.error({
      event: 'shutdown.tracked_work_failed',
      errName: (err as Error)?.name,
      errCode: (err as any)?.code ?? null,
      status: (err as any)?.output?.statusCode ?? (err as any)?.status ?? null,
    }))
    .finally(() => inFlight.delete(work));
}

export function inFlightCount(): number {
  return inFlight.size;
}

// Loops because work that starts while draining (a note arriving on a still-open socket) must finish too.
export async function drainInFlight(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise(resolve => { timer = setTimeout(resolve, remaining); }),
    ]);
    clearTimeout(timer);
  }
  return true;
}

// WhatsApp sockets close only after the drain: a reply needs the socket that received the note (WAY-057).
export function installGracefulShutdown(opts: {
  stopAccepting: () => void;
  closeSessions: () => Promise<void>;
}): void {
  let started = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    // A second signal mid-drain (deploy run twice) must not fall through to Node's default kill.
    if (started) return;
    started = true;
    setTimeout(() => process.exit(0), DRAIN_TIMEOUT_MS + CLOSE_GRACE_MS).unref();
    logger.info({ event: 'shutdown.start', signal, inFlight: inFlight.size });
    opts.stopAccepting();
    const drained = await drainInFlight(DRAIN_TIMEOUT_MS);
    if (drained) logger.info({ event: 'shutdown.drained' });
    else logger.warn({ event: 'shutdown.drain_timeout', inFlight: inFlight.size });
    await opts.closeSessions();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
