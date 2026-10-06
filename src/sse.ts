import { Response } from 'express';

interface SseClient {
  userId: number;
  res: Response;
}

const clients: SseClient[] = [];

export function addSseClient(userId: number, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client: SseClient = { userId, res };
  clients.push(client);

  const keepalive = setInterval(() => {
    res.write(':ping\n\n');
  }, 25000);

  res.on('close', () => {
    clearInterval(keepalive);
    const i = clients.indexOf(client);
    if (i !== -1) clients.splice(i, 1);
  });
}

export function emitToUser(userId: number, event: string, data: unknown): void {
  const payload = JSON.stringify(data);
  for (const c of clients) {
    if (c.userId === userId) {
      c.res.write(`event: ${event}\ndata: ${payload}\n\n`);
    }
  }
}

export function clientCount(userId: number): number {
  return clients.filter(c => c.userId === userId).length;
}
