import type { LogLevel } from '../settings/settingsTypes';
import { redact, redactString } from './redact';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  appendLine(line: string): void;
}

export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

/**
 * Structured, redacting logger. When verbose logging is disabled only warnings and errors are
 * written, so the output channel stays quiet in normal use.
 */
export class RedactingLogger implements Logger {
  private enabled = false;
  private level: LogLevel = 'info';

  constructor(
    private readonly sink: LogSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  configure(options: { enabled: boolean; level: LogLevel }): void {
    this.enabled = options.enabled;
    this.level = options.level;
  }

  debug(message: string, context?: unknown): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: unknown): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: unknown): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: unknown): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context: unknown): void {
    const threshold = this.enabled ? LEVELS[this.level] : LEVELS.warn;
    if (LEVELS[level] < threshold) return;
    let line = `${this.now().toISOString()} [${level.toUpperCase()}] ${redactString(message)}`;
    if (context !== undefined) {
      try {
        line += ` ${JSON.stringify(redact(context))}`;
      } catch {
        line += ' [unserializable context]';
      }
    }
    this.sink.appendLine(line);
  }
}

/** Logger that discards everything; handy for tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
