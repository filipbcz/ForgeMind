import type { ProviderKind } from './model.js';

export type NormalizedProviderErrorKind =
  | 'authentication'
  | 'quota'
  | 'timeout'
  | 'invalid_response'
  | 'unavailable'
  | 'unknown';

export interface NormalizedProviderErrorDetails {
  provider: ProviderKind;
  kind: NormalizedProviderErrorKind;
  message: string;
  auditSafeMessage: string;
  retryable: boolean;
  statusCode?: number;
}

export interface ProviderPreflightResult {
  provider: ProviderKind;
  ok: boolean;
  checkedAt: string;
  error?: NormalizedProviderErrorDetails;
}
