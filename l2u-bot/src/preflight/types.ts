export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about it, shown only for warn and fail. */
  readonly fix?: string;
}

export interface CheckSummary {
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
  /** Process exit code: non-zero when anything failed. */
  readonly exitCode: number;
}
