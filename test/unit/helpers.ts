import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Clock } from '../../src/utils/time';

export class FakeClock implements Clock {
  constructor(public time = Date.UTC(2026, 8, 30, 9, 0, 0)) {}
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'devpulse-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

export class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string) {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
}
