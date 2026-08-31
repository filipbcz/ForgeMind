export const requiredScenarioAreas = [
  'success',
  'repair',
  'restart',
  'outage',
  'approval_pause_resume',
  'specification_change',
  'audit_recovery',
  'disk_exhaustion',
  'database_restore'
];

export const qualificationScenarios = [
  {
    id: 'success-roadmap-step',
    area: 'success',
    title: 'Roadmap step completes with audit-linked evidence',
    objective: 'Verify the ordinary implementation path from submitted task through completed acceptance evidence.',
    activation: 'Start a single non-risky roadmap task from the Studio API or mobile operations UI.',
    expectedStates: [
      'task:submitted',
      'queue:pending',
      'queue:claimed',
      'run:running',
      'task:in_progress',
      'task:ready_for_user_review',
      'task:completed',
      'queue:succeeded',
      'run:succeeded'
    ],
    expectedAuditEvents: [
      'task_status_submitted',
      'task_queue_job_created',
      'task_queue_job_claimed',
      'task_run_started',
      'task_iteration_completed',
      'task_validation_completed',
      'task_github_operation_completed',
      'task_status_completed',
      'task_queue_job_finalized'
    ],
    evidenceArtifacts: [
      'task timeline export',
      'run iteration summary',
      'validation command transcript',
      'acceptance evidence records',
      'redacted diagnostic export'
    ],
    recoveryProcedure: [
      'Confirm the task has exactly one active queue job and one terminal run.',
      'If validation evidence is missing, retry the task from the latest safe checkpoint.',
      'If GitHub delivery evidence is missing, verify the adapter audit event before retrying delivery.'
    ]
  },
  {
    id: 'validation-repair',
    area: 'repair',
    title: 'Failed validation is repaired from a safe checkpoint',
    objective: 'Verify a failing validation command records failure evidence and resumes through repair without replaying completed effects.',
    activation: 'Run a task whose first implementation produces a deterministic failing validation check and whose repair passes.',
    expectedStates: [
      'task:submitted',
      'queue:claimed',
      'run:running',
      'iteration:validation_failed',
      'iteration:repair_implementation',
      'iteration:validation_succeeded',
      'task:completed',
      'run:succeeded'
    ],
    expectedAuditEvents: [
      'task_validation_failed',
      'task_validation_recovery_decision_recorded',
      'task_checkpoint_completed',
      'task_external_effect_skipped_on_retry',
      'task_validation_completed',
      'task_status_completed'
    ],
    evidenceArtifacts: [
      'failed validation transcript',
      'redacted AI recovery decision',
      'checkpoint list',
      'successful validation transcript'
    ],
    recoveryProcedure: [
      'Inspect the failed validation transcript and recovery decision.',
      'Retry only from the implementation or validation checkpoint selected by the recorded recovery decision.',
      'Confirm completed external-effect checkpoints are marked skipped rather than repeated.'
    ]
  },
  {
    id: 'worker-restart-resume',
    area: 'restart',
    title: 'Worker restart resumes the claimed job',
    objective: 'Verify an interrupted worker run can resume from persisted queue, run, and checkpoint state.',
    activation: 'Capture a restart snapshot while a validation checkpoint is active, stop the worker, start it again, then run restart verification.',
    expectedStates: [
      'queue:claimed',
      'run:running',
      'worker:offline',
      'queue:pending_after_claim_timeout',
      'queue:claimed_by_restarted_worker',
      'run:running_after_resume',
      'task:completed',
      'run:succeeded'
    ],
    expectedAuditEvents: [
      'worker_heartbeat_missed',
      'task_queue_job_recovered',
      'task_queue_job_claimed',
      'task_checkpoint_skipped',
      'task_status_completed'
    ],
    evidenceArtifacts: [
      'restart snapshot',
      'worker heartbeat gap',
      'recovered queue job record',
      'checkpoint resume log'
    ],
    recoveryProcedure: [
      'Wait for the configured claim timeout before starting a replacement worker.',
      'Run the queue recovery path and confirm the claimed job returns to pending.',
      'Start one worker and confirm checkpoints skip already completed validation commands.'
    ]
  },
  {
    id: 'provider-and-github-outage',
    area: 'outage',
    title: 'Transient provider or GitHub outage is isolated and retryable',
    objective: 'Verify external outages produce bounded failure evidence without unsafe fallback or duplicate GitHub effects.',
    activation: 'Run with a deterministic provider or GitHub adapter outage fixture for one operation.',
    expectedStates: [
      'task:submitted',
      'queue:claimed',
      'run:running',
      'run:failed',
      'queue:pending_with_backoff',
      'task:submitted',
      'queue:claimed_after_backoff',
      'run:succeeded'
    ],
    expectedAuditEvents: [
      'provider_preflight_failed_or_external_operation_failed',
      'provider_fallback_skipped_or_task_github_operation_failed',
      'task_queue_job_finalized',
      'task_queue_job_requeued',
      'task_external_effect_skipped_on_retry',
      'task_status_completed'
    ],
    evidenceArtifacts: [
      'bounded outage error',
      'retry backoff metadata',
      'idempotent external operation checkpoint',
      'final success transcript'
    ],
    recoveryProcedure: [
      'Do not change provider kind or model unless an approved same-kind fallback exists.',
      'Allow the queue backoff to expire or manually retry the task through the existing retry endpoint.',
      'Before retrying GitHub delivery, verify the adapter idempotency lookup for branch or pull request state.'
    ]
  },
  {
    id: 'approval-pause-resume',
    area: 'approval_pause_resume',
    title: 'Risky operation pauses until explicit approval',
    objective: 'Verify risky work enters needs_approval, records task-scoped approval, and resumes only after approval.',
    activation: 'Run a task whose provider outcome requests a risky operation allowed only by explicit approval.',
    expectedStates: [
      'task:submitted',
      'run:running',
      'task:needs_approval',
      'approval:pending',
      'queue:paused_for_approval',
      'approval:approved',
      'task:submitted_after_approval',
      'queue:pending',
      'task:completed'
    ],
    expectedAuditEvents: [
      'task_status_needs_approval',
      'approval_created',
      'approval_approved',
      'task_status_submitted',
      'task_queue_job_created',
      'task_status_completed'
    ],
    evidenceArtifacts: [
      'approval record',
      'approval audit trail',
      'pre-approval paused queue snapshot',
      'post-approval resumed run'
    ],
    recoveryProcedure: [
      'Leave the task in needs_approval until a user approves or rejects the task-scoped approval.',
      'If approval is granted, use the existing approval endpoint so resume is audited and re-enqueued.',
      'If approval is rejected, keep the terminal blocked or failed state with the rejection rationale.'
    ]
  },
  {
    id: 'specification-change-regeneration',
    area: 'specification_change',
    title: 'Specification change preserves unfinished work and contract history',
    objective: 'Verify a spec change creates versioned contract and roadmap records while preserving unfinished active requirements.',
    activation: 'Save a revised project brief and generate the next roadmap cycle from a historical contract base.',
    expectedStates: [
      'specification:v1_active',
      'contract:v1_active',
      'roadmap_cycle:active',
      'specification:v2_created',
      'contract:v2_active',
      'roadmap_cycle:new_active',
      'unfinished_steps:carried_forward',
      'removed_requirements:superseded_or_removed'
    ],
    expectedAuditEvents: [
      'project_specification_version_created',
      'project_contract_version_created',
      'project_roadmap_cycle_created',
      'project_contract_recovery_requested',
      'project_roadmap_validation_completed'
    ],
    evidenceArtifacts: [
      'specification version diff',
      'contract version diff',
      'roadmap validation report',
      'unfinished step carry-forward list'
    ],
    recoveryProcedure: [
      'Recover only from an immutable historical contract version older than the latest contract.',
      'Regenerate the roadmap through the contract-aware API path.',
      'Confirm every unfinished active requirement remains covered before saving the new cycle.'
    ]
  },
  {
    id: 'manual-audit-recovery',
    area: 'audit_recovery',
    title: 'Interrupted manual audit job can be recovered',
    objective: 'Verify final audit remains user-triggered and an interrupted audit job can retry without duplicate completion.',
    activation: 'After qualification evidence exists, manually start an audit job and interrupt it before the terminal audit record is written.',
    expectedStates: [
      'qualification_evidence:present',
      'audit_action:manually_triggered',
      'audit_job:queued',
      'audit_job:running',
      'audit_job:interrupted',
      'audit_job:retryable',
      'audit_job:running_after_retry',
      'audit_job:succeeded_or_failed_with_evidence'
    ],
    expectedAuditEvents: [
      'project_audit_requested',
      'project_audit_job_started',
      'project_audit_job_recovered',
      'project_audit_job_completed_or_failed'
    ],
    evidenceArtifacts: [
      'manual trigger record',
      'audit job heartbeat history',
      'recovery attempt record',
      'terminal audit evidence'
    ],
    recoveryProcedure: [
      'Do not auto-start a replacement final audit.',
      'Use the manual audit action after confirming the previous job is retryable or terminal.',
      'Ensure the latest cycle still has qualification evidence before accepting terminal audit evidence.'
    ]
  },
  {
    id: 'disk-exhaustion-artifact-bounds',
    area: 'disk_exhaustion',
    title: 'Disk exhaustion preserves bounded evidence and recoverability',
    objective: 'Verify artifact and log capture is bounded, redacted, and leaves the task recoverable when storage is exhausted.',
    activation: 'Run a fixture command that writes until it reaches the configured artifact size or disk exhaustion limit.',
    expectedStates: [
      'task:submitted',
      'run:running',
      'artifact_capture:bounded',
      'artifact_capture:failed_or_truncated',
      'run:failed',
      'queue:pending_with_backoff_or_task:failed_after_limit',
      'operator_cleanup:required',
      'task:retryable_after_cleanup'
    ],
    expectedAuditEvents: [
      'artifact_upload_started',
      'artifact_upload_truncated_or_failed',
      'task_validation_failed',
      'task_queue_job_finalized',
      'operator_recovery_required'
    ],
    evidenceArtifacts: [
      'artifact manifest with byte counts',
      'redaction report',
      'bounded failure transcript',
      'operator cleanup checklist'
    ],
    recoveryProcedure: [
      'Stop new claims by pausing the queue if free space is below the operator threshold.',
      'Remove only disposable workspace and artifact cache paths documented for the environment.',
      'Resume the queue and retry the affected task from the latest persisted checkpoint.'
    ]
  },
  {
    id: 'database-restore-path',
    area: 'database_restore',
    title: 'Database restore validates migrations and audit continuity',
    objective: 'Verify a restored database can apply forward migrations and preserve task, run, approval, and audit continuity.',
    activation: 'Restore a supported previous-schema fixture into an isolated PostgreSQL database and run migration validation.',
    expectedStates: [
      'database:restored_previous_schema',
      'migrations:applied_forward',
      'task_records:readable',
      'queue_records:readable',
      'approval_records:readable',
      'audit_records:readable',
      'application:starts_against_restored_database'
    ],
    expectedAuditEvents: [
      'database_restore_started',
      'database_migration_validation_completed',
      'database_restore_verified'
    ],
    evidenceArtifacts: [
      'restore command transcript',
      'migration validation transcript',
      'post-restore record counts',
      'audit continuity report'
    ],
    recoveryProcedure: [
      'Restore into an isolated database, never over the running production database.',
      'Run the forward-only migration validator before starting application workers.',
      'Start API first, verify read paths, then resume workers after queue and audit counts are consistent.'
    ]
  }
];
