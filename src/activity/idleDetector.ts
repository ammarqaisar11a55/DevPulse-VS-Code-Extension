/**
 * Deterministic active-time accounting.
 *
 * Time between two consecutive activity signals counts as active when the gap is at most the
 * idle threshold; longer gaps are idle. Periods that must never count (window unfocused, work in
 * an excluded project) are skipped by moving `creditFrom` forward.
 */
export class IdleDetector {
  private lastActivity: number;
  private creditFrom: number;

  constructor(
    private thresholdMs: number,
    start: number,
  ) {
    this.lastActivity = start;
    this.creditFrom = start;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  get idleThresholdMs(): number {
    return this.thresholdMs;
  }

  setThreshold(ms: number): void {
    this.thresholdMs = ms;
  }

  /** Milliseconds since the last activity (0 if the clock went backwards). */
  gapAt(at: number): number {
    return Math.max(0, at - this.lastActivity);
  }

  isIdleAt(now: number): boolean {
    return now - this.lastActivity >= this.thresholdMs;
  }

  /**
   * Records activity at `at` and returns how many milliseconds of active time it adds.
   * A clock that moved backwards resets the reference point without crediting anything.
   */
  record(at: number): number {
    if (at < this.lastActivity) {
      this.lastActivity = at;
      this.creditFrom = at;
      return 0;
    }
    const from = Math.max(this.lastActivity, this.creditFrom);
    const gap = at - from;
    this.lastActivity = at;
    return gap > 0 && gap <= this.thresholdMs ? gap : 0;
  }

  /** Time until `at` must not be credited (e.g. the window was unfocused until now). */
  skipUntil(at: number): void {
    this.creditFrom = Math.max(this.creditFrom, at);
  }

  /** Restarts accounting at `at`, e.g. when idle ends: the idle gap is not credited. */
  restartAt(at: number): void {
    this.lastActivity = at;
    this.creditFrom = at;
  }
}
