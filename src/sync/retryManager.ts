import type { Clock } from '../utils/time';

/** Delay before attempt 2, 3, … (attempt 1 is immediate). */
export const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 300_000];
/** Upper bound for any delay, including server-requested ones. */
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Exponential backoff shared by all synchronization work. After a failure no request is made
 * until the delay passes; a success resets it. Server-provided delays (429 / Retry-After) win
 * when longer.
 */
export class RetryManager {
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(
    private readonly clock: Clock,
    private readonly schedule: readonly number[] = DEFAULT_BACKOFF_MS,
    private readonly jitter: (delay: number) => number = (delay) =>
      Math.round(delay * (0.9 + Math.random() * 0.2)),
  ) {}

  get consecutiveFailures(): number {
    return this.failures;
  }

  canAttempt(): boolean {
    return this.clock.now() >= this.nextAttemptAt;
  }

  /** Milliseconds until the next attempt is allowed (0 when allowed now). */
  remainingMs(): number {
    return Math.max(0, this.nextAttemptAt - this.clock.now());
  }

  recordSuccess(): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  /** Records a failure and returns the delay before the next attempt. */
  recordFailure(serverDelayMs?: number): number {
    this.failures += 1;
    const index = Math.min(this.failures - 1, this.schedule.length - 1);
    const backoff = this.jitter(this.schedule[index] ?? 0);
    const delay = Math.min(MAX_BACKOFF_MS, Math.max(backoff, serverDelayMs ?? 0));
    this.nextAttemptAt = this.clock.now() + delay;
    return delay;
  }

  reset(): void {
    this.recordSuccess();
  }
}
