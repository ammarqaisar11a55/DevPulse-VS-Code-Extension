import { describe, expect, it } from 'vitest';
import { RetryManager } from '../../src/sync/retryManager';
import { FakeClock } from './helpers';

describe('RetryManager', () => {
  const noJitter = (delay: number) => delay;

  it('backs off exponentially and caps at the last step', () => {
    const clock = new FakeClock();
    const retry = new RetryManager(clock, undefined, noJitter);
    expect(retry.canAttempt()).toBe(true);
    const delays = Array.from({ length: 7 }, () => retry.recordFailure());
    expect(delays).toEqual([5_000, 15_000, 30_000, 60_000, 300_000, 300_000, 300_000]);
  });

  it('blocks attempts until the delay passes', () => {
    const clock = new FakeClock();
    const retry = new RetryManager(clock, undefined, noJitter);
    retry.recordFailure();
    expect(retry.canAttempt()).toBe(false);
    expect(retry.remainingMs()).toBe(5_000);
    clock.advance(5_000);
    expect(retry.canAttempt()).toBe(true);
  });

  it('honours longer server-requested delays', () => {
    const retry = new RetryManager(new FakeClock(), undefined, noJitter);
    expect(retry.recordFailure(42_000)).toBe(42_000);
    expect(retry.recordFailure(1_000)).toBe(15_000);
  });

  it('resets after a success', () => {
    const retry = new RetryManager(new FakeClock(), undefined, noJitter);
    retry.recordFailure();
    retry.recordFailure();
    retry.recordSuccess();
    expect(retry.consecutiveFailures).toBe(0);
    expect(retry.canAttempt()).toBe(true);
    expect(retry.recordFailure()).toBe(5_000);
  });
});
