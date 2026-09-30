/** Tiny runtime checks for API responses; the server is trusted but still validated. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export type Obj = Record<string, unknown>;

export function obj(value: unknown, label: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Obj;
}

export function str(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
  return value;
}

export function optStr(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : str(value, label);
}

export function num(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a number`);
  }
  return value;
}

export function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be a boolean`);
  return value;
}
