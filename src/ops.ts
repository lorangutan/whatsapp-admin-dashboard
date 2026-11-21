import type { FastifyBaseLogger } from 'fastify';

/**
 * Alerts for whoever runs this server (not the shop): problems the dashboard can't show, like a number that
 * looks connected while WhatsApp holds its chats back, or messages that couldn't be saved.
 * Always logged as "ops alert"; also POSTed as plain text to OPS_ALERT_URL when set (an ntfy.sh topic URL
 * works as is: install the ntfy app and subscribe to the same topic). Never put customer data in `text`.
 */
const lastSent = new Map<string, number>();
const REPEAT_AFTER_MS = 60 * 60_000;

export function opsAlert(log: FastifyBaseLogger, key: string, text: string) {
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < REPEAT_AFTER_MS) return;
  lastSent.set(key, now);
  log.error({ key, text }, 'ops alert');
  const url = process.env.OPS_ALERT_URL;
  if (!url) return;
  fetch(url, { method: 'POST', body: text, headers: { Title: 'Wamon', Tags: 'warning' }, signal: AbortSignal.timeout(10_000) })
    .then((res) => {
      if (!res.ok) log.warn({ status: res.status }, 'ops alert not delivered');
    })
    .catch((err) => log.warn({ err: (err as Error).message }, 'ops alert not delivered'));
}
