import type { ErrorCode, Failure } from './contracts.js';

export class PreviewError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message.slice(0, 1024));
    this.name = 'PreviewError';
  }
  toJSON(): Failure { return { code: this.code, message: this.message }; }
}
export function failure(error: unknown, fallback: ErrorCode = 'START_FAILED'): Failure {
  return error instanceof PreviewError ? error.toJSON() : {
    code: fallback,
    message: (error instanceof Error ? error.message : 'The operation failed.').slice(0, 1024),
  };
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PreviewError('CLOSED', 'The operation was canceled.');
}
