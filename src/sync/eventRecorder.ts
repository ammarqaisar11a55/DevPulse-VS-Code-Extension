import { randomUUID } from 'node:crypto';
import type { EventQueueStore } from '../storage/queueStore';
import type { ActivityEventType, EventMetadata, QueuedEvent } from '../storage/storageTypes';
import type { Logger } from '../utils/logger';

/** Events kept in memory at most, if the disk is temporarily unwritable. */
const MAX_BUFFERED = 2000;

/**
 * Buffers activity events in memory and writes them to the durable queue in batches, so a
 * burst of editor activity costs one small file write instead of many.
 */
export class EventRecorder {
  private buffer: QueuedEvent[] = [];
  private flushing: Promise<void> | undefined;
  private droppedValue = 0;

  constructor(
    private readonly queue: EventQueueStore,
    private readonly logger: Logger,
    private readonly flushThreshold = 100,
  ) {}

  get buffered(): number {
    return this.buffer.length;
  }

  /** Events dropped because the queue hit its size limit. */
  get dropped(): number {
    return this.droppedValue;
  }

  record(
    type: ActivityEventType,
    occurredAt: number,
    clientSessionId: string | undefined,
    options: { language?: string | null; metadata?: EventMetadata } = {},
  ): void {
    const event: QueuedEvent = { clientEventId: randomUUID(), type, occurredAt };
    if (clientSessionId) event.clientSessionId = clientSessionId;
    if (options.language) event.language = options.language;
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      event.metadata = options.metadata;
    }
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFERED) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
    if (this.buffer.length >= this.flushThreshold) void this.flush();
  }

  /** Writes buffered events to disk. Safe to call concurrently. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flush());
    if (this.buffer.length === 0) return Promise.resolve();
    const batch = this.buffer;
    this.buffer = [];
    this.flushing = this.queue
      .append(batch)
      .then((dropped) => {
        if (dropped > 0) {
          this.droppedValue += dropped;
          this.logger.warn(`Offline queue is full; dropped ${dropped} oldest events`);
        }
      })
      .catch((error: unknown) => {
        this.logger.error('Could not write activity to the local queue', error);
        this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFERED);
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  /** Forgets buffered events (used after pausing or clearing the queue). */
  discard(): void {
    this.buffer = [];
  }
}
