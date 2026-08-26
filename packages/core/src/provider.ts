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

export type ProviderCircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface ProviderCircuitBreakerSnapshot {
  state: ProviderCircuitBreakerState;
  failureCount: number;
  failureThreshold: number;
  openedAt?: string;
  openedUntil?: string;
  lastFailureAt?: string;
  lastFailureKind?: NormalizedProviderErrorKind;
  lastFailureMessage?: string;
}

export interface ProviderConnectionRuntimeStatus {
  provider: ProviderKind;
  connectionId: string | null;
  model: string | null;
  lastSuccessfulRequestAt: string | null;
  lastSuccessfulOperation: string | null;
  circuitBreaker: ProviderCircuitBreakerSnapshot;
}
