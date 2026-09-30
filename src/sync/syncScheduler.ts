import type { Logger } from '../utils/logger';
import type { SyncEngine } from './syncEngine';
import type { SyncResult } from './syncTypes';

export interface PeriodicTask {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
}

/** Delay before continuing when a pass left a backlog (large offline queues). */
const BACKLOG_DELAY_MS = 5_000;

/**
 * Drives synchronization: a periodic pass (the heartbeat for open sessions), debounced
 * triggers for lifecycle events, and low-frequency housekeeping. No timers run faster than
 * every few seconds, and nothing runs while disconnected.
 */
export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly engine: SyncEngine,
    private readonly intervalMs: () => number,
    private readonly tasks: PeriodicTask[],
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
    private readonly onResult: (result: SyncResult) => void = () => undefined,
  ) {}

  start(initialDelayMs = 3_000): void {
    this.schedule(initialDelayMs);
  }

  /** Requests a sync soon, e.g. after a session ended or the device connected. */
  trigger(delayMs = 2_000): void {
    this.schedule(delayMs);
  }

  /** Syncs immediately, ignoring backoff (the Sync Now command). */
  async syncNow(): Promise<SyncResult> {
    const result = await this.engine.sync({ force: true });
    this.onResult(result);
    this.schedule(this.nextDelay(result));
    return result;
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), Math.max(0, delayMs));
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    let result: SyncResult | undefined;
    try {
      result = await this.engine.sync();
      this.onResult(result);
      await this.runTasks();
    } catch (error) {
      this.logger.error('Scheduled sync failed', error);
    }
    this.schedule(this.nextDelay(result));
  }

  private nextDelay(result: SyncResult | undefined): number {
    const interval = this.intervalMs();
    if (result?.ok && result.pendingEvents > 0) return BACKLOG_DELAY_MS;
    const backoff = this.engine.snapshot.nextAttemptInMs;
    return backoff > 0 ? Math.min(Math.max(backoff, 1_000), 60 * 60 * 1000) : interval;
  }

  private async runTasks(): Promise<void> {
    const now = this.now();
    for (const task of this.tasks) {
      const last = this.lastRun.get(task.name);
      if (last !== undefined && now - last < task.everyMs) continue;
      this.lastRun.set(task.name, now);
      try {
        await task.run();
      } catch (error) {
        this.logger.warn(`Background task "${task.name}" failed`, error);
      }
    }
  }

  /** Forces a periodic task to run on the next pass. */
  invalidate(name: string): void {
    this.lastRun.delete(name);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
