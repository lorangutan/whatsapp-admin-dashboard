import { EventEmitter } from 'node:events';

/** What changed, pushed to open dashboards over Server-Sent Events so they update without polling. */
export type LiveEvent =
  | { type: 'messages'; chatIds: number[] }
  | { type: 'chat'; chatId: number }
  | { type: 'channel'; channelId: number; status: string }
  | { type: 'followups' };

class Bus extends EventEmitter {
  publish(event: LiveEvent) {
    this.emit('event', event);
  }
  subscribe(fn: (event: LiveEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
