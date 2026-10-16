import { redactSecrets, WINDOWS_AUTHORING_PROTOCOL_VERSIONS, type WindowsAuthoringProgress, type WindowsEvidenceUpload, type WindowsExecutionJob, type WindowsExecutionLease, type WindowsJobResult, type WorkerCapability, type WorkerProbeEvidence } from '@forgemind/core';
import type { RunnerCredential } from './credential-store.js';

export interface RunnerControlState { deviceStatus: string; sessionStatus: string; leaseStatus?: string; jobStatus?: string }
export interface LeaseClaim { job: WindowsExecutionJob | null; lease: WindowsExecutionLease | null }
export interface WindowsProviderConnection {
  id: string;
  name: string;
  authMode: 'api_key' | 'chatgpt_plan_oauth';
  model: string;
  allowedModels: string[];
  credential: string;
}
export interface WindowsUnavailableProviderConnection {
  id: string;
  name: string;
  authMode: 'api_key' | 'chatgpt_plan_oauth';
  reason: 'credential_unavailable';
}
export interface WindowsProviderPool {
  connections: WindowsProviderConnection[];
  unavailableConnections?: WindowsUnavailableProviderConnection[];
}
export const WINDOWS_RUNNER_LEASE_SECONDS = 300;

/** Outbound-only HTTPS control-plane client. It never opens a listening socket. */
export class WindowsRunnerTransport {
  private readonly baseUrl: URL;
  constructor(baseUrl: string, private readonly request: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:') throw new Error('Windows runner API URL must use HTTPS.');
  }
  enroll(code: string) { return this.call<RunnerCredential>('/api/windows-runner/enroll', undefined, { code }); }
  exchangeChatGPTPlanEnrollment(auth: RunnerCredential, code: string) {
    return this.call<{ uploadToken: string; hostId: string; expiresAt: string }>('/api/windows-runner/device/chatgpt-plan/enroll', auth, { code });
  }
  completeChatGPTPlanEnrollment(auth: RunnerCredential, input: {
    uploadToken: string; nonce: string; clientId: string; accessToken: string; refreshToken: string;
    idToken: string; scope: string; expiresIn: number;
  }) {
    return this.call<{ ok: true; connection: { id: string; name: string; accountSummary?: string } }>(
      '/api/windows-runner/device/chatgpt-plan/complete', auth, input
    );
  }
  providerPool(auth: RunnerCredential) {
    return this.call<WindowsProviderPool>('/api/windows-runner/device/provider-pool', auth, undefined, 'GET');
  }
  publishDevice(auth: RunnerCredential, input: { runnerVersion: string; displayName: string; capabilities: WorkerCapability[]; probeEvidence: WorkerProbeEvidence[] }) {
    return this.call('/api/windows-runner/device', auth, input, 'PUT');
  }
  startSession(auth: RunnerCredential, projectIds: string[]) { return this.call<{ sessionId: string }>('/api/windows-runner/device/session', auth, { projectIds }); }
  claim(auth: RunnerCredential, sessionId: string, requestId: string) { return this.call<LeaseClaim>('/api/windows-runner/device/lease', auth, { sessionId, requestId, leaseSeconds: WINDOWS_RUNNER_LEASE_SECONDS, authoringProtocolVersions: [...WINDOWS_AUTHORING_PROTOCOL_VERSIONS] }); }
  heartbeat(auth: RunnerCredential, sessionId: string, leaseId?: string) { return this.call('/api/windows-runner/device/heartbeat', auth, { sessionId, leaseId, leaseSeconds: WINDOWS_RUNNER_LEASE_SECONDS }); }
  control(auth: RunnerCredential, sessionId: string, leaseId?: string) {
    const query = new URLSearchParams({ sessionId }); if (leaseId) query.set('leaseId', leaseId);
    return this.call<RunnerControlState>(`/api/windows-runner/device/control?${query}`, auth, undefined, 'GET');
  }
  drain(auth: RunnerCredential, sessionId: string) { return this.call('/api/windows-runner/device/session/drain', auth, { sessionId }); }
  stop(auth: RunnerCredential, sessionId: string) { return this.call('/api/windows-runner/device/session/stop', auth, { sessionId }); }
  uploadEvidence(auth: RunnerCredential, input: WindowsEvidenceUpload) { return this.call<{ accepted: boolean; duplicate: boolean }>('/api/windows-runner/device/evidence', auth, input); }
  publishAuthoringProgress(auth: RunnerCredential, input: WindowsAuthoringProgress) { return this.call<{ accepted: boolean }>('/api/windows-runner/device/authoring-progress', auth, input); }
  uploadAuthoringBlobChunk(auth: RunnerCredential, input: { jobId: string; leaseId: string; sessionId: string; nonce: string; inputHash: string;
    sha256: string; sizeBytes: number; chunkIndex: number; totalChunks: number; contentBase64: string }) {
    return this.call<{ accepted: boolean; duplicate: boolean }>('/api/windows-runner/device/authoring-blob/chunk', auth, input);
  }
  completeAuthoringBlob(auth: RunnerCredential, input: { jobId: string; leaseId: string; sessionId: string; nonce: string; inputHash: string;
    sha256: string; sizeBytes: number; totalChunks: number }) {
    return this.call<{ accepted: boolean; duplicate: boolean }>('/api/windows-runner/device/authoring-blob/complete', auth, input);
  }
  submitResult(auth: RunnerCredential, input: WindowsJobResult) { return this.call<{ accepted: boolean }>('/api/windows-runner/device/result', auth, input); }
  close(auth: RunnerCredential, sessionId: string) { return this.call('/api/windows-runner/device/session/close', auth, { sessionId }); }
  private async call<T = unknown>(path: string, auth?: RunnerCredential, body?: unknown, method = 'POST'): Promise<T> {
    const response = await this.request(new URL(path, this.baseUrl), {
      method, headers: { ...(auth ? { authorization: `Bearer ${auth.credential}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(path === '/api/windows-runner/device/result' ? 300_000 : 30_000)
    });
    const responseText = await response.text();
    if (!response.ok) {
      let diagnostic = responseText;
      try {
        const parsed = JSON.parse(responseText) as { error?: unknown; issues?: unknown };
        if (typeof parsed.error === 'string') diagnostic = `${parsed.error}${!parsed.error.includes('Invalid sections:') && Array.isArray(parsed.issues) && parsed.issues.length
          ? ` Invalid sections: ${parsed.issues.filter((issue): issue is string => typeof issue === 'string').join(', ')}.` : ''}`;
      } catch { /* preserve a plain-text server diagnostic */ }
      throw new Error(`ForgeMind API request failed (${response.status}): ${redactSecrets(diagnostic).slice(0, 4_000) || 'no server diagnostic'}`);
    }
    try { return JSON.parse(responseText) as T; } catch { throw new Error(`ForgeMind API returned invalid JSON (${response.status}).`); }
  }
}
