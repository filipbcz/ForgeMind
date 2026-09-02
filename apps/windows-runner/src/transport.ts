import type { WindowsEvidenceUpload, WindowsExecutionJob, WindowsExecutionLease, WindowsExecutionResult, WorkerCapability, WorkerProbeEvidence } from '@forgemind/core';
import type { RunnerCredential } from './credential-store.js';

export interface RunnerControlState { deviceStatus: string; sessionStatus: string; leaseStatus?: string; jobStatus?: string }
export interface LeaseClaim { job: WindowsExecutionJob | null; lease: WindowsExecutionLease | null }

/** Outbound-only HTTPS control-plane client. It never opens a listening socket. */
export class WindowsRunnerTransport {
  private readonly baseUrl: URL;
  constructor(baseUrl: string, private readonly request: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:') throw new Error('Windows runner API URL must use HTTPS.');
  }
  enroll(code: string) { return this.call<RunnerCredential>('/api/windows-runner/enroll', undefined, { code }); }
  publishDevice(auth: RunnerCredential, input: { runnerVersion: string; displayName: string; capabilities: WorkerCapability[]; probeEvidence: WorkerProbeEvidence[] }) {
    return this.call('/api/windows-runner/device', auth, input, 'PUT');
  }
  startSession(auth: RunnerCredential, expiresInMinutes: number) { return this.call<{ sessionId: string }>('/api/windows-runner/device/session', auth, { expiresInMinutes }); }
  claim(auth: RunnerCredential, sessionId: string, requestId: string) { return this.call<LeaseClaim>('/api/windows-runner/device/lease', auth, { sessionId, requestId }); }
  heartbeat(auth: RunnerCredential, sessionId: string, leaseId?: string) { return this.call('/api/windows-runner/device/heartbeat', auth, { sessionId, leaseId }); }
  control(auth: RunnerCredential, sessionId: string, leaseId?: string) {
    const query = new URLSearchParams({ sessionId }); if (leaseId) query.set('leaseId', leaseId);
    return this.call<RunnerControlState>(`/api/windows-runner/device/control?${query}`, auth, undefined, 'GET');
  }
  drain(auth: RunnerCredential, sessionId: string) { return this.call('/api/windows-runner/device/session/drain', auth, { sessionId }); }
  uploadEvidence(auth: RunnerCredential, input: WindowsEvidenceUpload) { return this.call<{ accepted: boolean; duplicate: boolean }>('/api/windows-runner/device/evidence', auth, input); }
  submitResult(auth: RunnerCredential, input: WindowsExecutionResult) { return this.call<{ accepted: boolean }>('/api/windows-runner/device/result', auth, input); }
  close(auth: RunnerCredential, sessionId: string) { return this.call('/api/windows-runner/device/session/close', auth, { sessionId }); }
  private async call<T = unknown>(path: string, auth?: RunnerCredential, body?: unknown, method = 'POST'): Promise<T> {
    const response = await this.request(new URL(path, this.baseUrl), {
      method, headers: { ...(auth ? { authorization: `Bearer ${auth.credential}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error(`ForgeMind API request failed (${response.status}).`);
    return await response.json() as T;
  }
}
