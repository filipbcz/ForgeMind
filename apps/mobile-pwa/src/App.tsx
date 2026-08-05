import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Activity,
  ArrowDown,
  ArrowRight,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FolderPlus,
  GitBranch,
  Github,
  LayoutList,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Smartphone,
  Trash2,
  XCircle
} from 'lucide-react';
import {
  assignProjectRepository as assignProjectRepositoryRequest,
  cancelTask as cancelTaskRequest,
  completeTask as completeTaskRequest,
  connectGitHubAdapter,
  connectProvider,
  completeCodexOAuth,
  decideProjectRoadmapExtension as decideProjectRoadmapExtensionRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  deleteProviderConnection,
  deleteProject as deleteProjectRequest,
  disconnectGitHubAdapter,
  fetchGitHubAdapterStatus,
  fetchGitHubBranches,
  fetchGitHubRepositories,
  fetchGitHubRepositoryOwners,
  fetchNotificationSettings,
  fetchProjectRoadmap,
  fetchProviderStatus,
  fetchNotificationVapidPublicKey,
  fetchApprovals,
  fetchProjects,
  fetchTaskDiff,
  fetchTaskLogs,
  fetchTaskQueue,
  fetchTaskRuns,
  fetchTasks,
  fetchWorkerEvents,
  fetchWorkerStatus,
  generateProjectRoadmap as generateProjectRoadmapRequest,
  resolveApproval as resolveApprovalRequest,
  retryTask as retryTaskRequest,
  setWorkerQueuePaused,
  subscribeNotification,
  startCodexOAuth,
  startTask as startTaskRequest,
  unsubscribeNotification,
  updateProject as updateProjectRequest,
  updateNotificationSettings
} from './api.js';
import { subscribeForPushNotifications, unsubscribeFromPushNotifications } from './pwa.js';
import type {
  ApprovalSummary,
  AssignProjectRepositoryRequest,
  AuditEventApi,
  CodexOAuthStartResponse,
  CreateProjectRequest,
  CreateTaskRequest,
  DecideProjectRoadmapExtensionRequest,
  DeleteProjectRequest,
  GenerateProjectRoadmapRequest,
  GitHubAdapterConnectRequest,
  GitHubAdapterStatusApi,
  GitHubBranchApi,
  ProjectRoadmapApi,
  GitHubRepositoryApi,
  GitHubRepositoryOwnerApi,
  NotificationSettingsApi,
  ProviderConnectRequest,
  ProviderConnectionApi,
  ProviderStatusApi,
  ProjectSummary,
  RealtimeMessage,
  TaskDiffApi,
  TaskQueueApi,
  TaskSummary,
  TaskUsageApi,
  UpdateProjectRequest,
  WorkerStatusApi
} from './types.js';
import { subscribeRealtime } from './realtime.js';
import type { RealtimeConnectionMeta, RealtimeConnectionState } from './realtime.js';

type View = 'tasks' | 'new-task' | 'approvals' | 'projects' | 'settings';
type RealtimeUiState = 'connected' | 'reconnecting' | 'fallback';

const terminalStatuses = new Set<TaskSummary['status']>([
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'iteration_limit_reached',
  'repeated_error_detected',
  'approval_rejected',
  'provider_failed',
  'validation_failed'
]);

const errorStatuses = new Set<TaskSummary['status']>([
  'failed',
  'budget_exceeded',
  'iteration_limit_reached',
  'repeated_error_detected',
  'approval_rejected',
  'provider_failed',
  'validation_failed'
]);

const activeStatuses = new Set<TaskSummary['status']>([
  'submitted',
  'planning',
  'creating_github_issue',
  'creating_branch',
  'running_ai',
  'validating',
  'reviewing',
  'improving',
  'creating_pr',
  'needs_approval'
]);

const statusLabels: Record<TaskSummary['status'], string> = {
  draft: 'Draft',
  submitted: 'Queued',
  planning: 'Planning',
  waiting_for_plan_approval: 'Plan approval',
  creating_github_issue: 'Creating issue',
  creating_branch: 'Creating branch',
  running_ai: 'Running AI',
  validating: 'Validating',
  reviewing: 'Reviewing',
  improving: 'Improving',
  needs_approval: 'Needs approval',
  creating_pr: 'Creating PR',
  ready_for_user_review: 'Ready for review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  budget_exceeded: 'Budget exceeded',
  iteration_limit_reached: 'Iteration limit',
  repeated_error_detected: 'Repeated error',
  approval_rejected: 'Approval rejected',
  provider_failed: 'Provider failed',
  validation_failed: 'Validation failed'
};

const statusIcons: Record<TaskSummary['status'], typeof Clock3> = {
  draft: Clock3,
  submitted: Clock3,
  planning: LayoutList,
  waiting_for_plan_approval: ShieldCheck,
  creating_github_issue: Github,
  creating_branch: GitBranch,
  running_ai: GitBranch,
  validating: ClipboardCheck,
  reviewing: ClipboardCheck,
  improving: RefreshCw,
  needs_approval: AlertTriangle,
  creating_pr: ClipboardCheck,
  ready_for_user_review: CheckCircle2,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
  budget_exceeded: AlertTriangle,
  iteration_limit_reached: AlertTriangle,
  repeated_error_detected: AlertTriangle,
  approval_rejected: XCircle,
  provider_failed: XCircle,
  validation_failed: XCircle
};

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [globalRealtimeState, setGlobalRealtimeState] = useState<RealtimeUiState>('fallback');
  const [taskRealtimeState, setTaskRealtimeState] = useState<RealtimeUiState>('fallback');
  const [globalRealtimeMeta, setGlobalRealtimeMeta] = useState<RealtimeConnectionMeta>({ state: 'idle' });
  const [taskRealtimeMeta, setTaskRealtimeMeta] = useState<RealtimeConnectionMeta>({ state: 'idle' });

  const globalPollInterval = globalRealtimeState === 'connected' ? false : 15000;

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, retry: 1 });
  const tasksQuery = useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: globalPollInterval, retry: 1 });
  const approvalsQuery = useQuery({ queryKey: ['approvals'], queryFn: fetchApprovals, refetchInterval: globalPollInterval, retry: 1 });
  const notificationSettingsQuery = useQuery({
    queryKey: ['notification-settings'],
    queryFn: fetchNotificationSettings,
    retry: 1
  });
  const providerStatusQuery = useQuery({
    queryKey: ['provider-status'],
    queryFn: fetchProviderStatus,
    retry: 1
  });
  const githubAdapterStatusQuery = useQuery({
    queryKey: ['github-adapter-status'],
    queryFn: fetchGitHubAdapterStatus,
    retry: 1
  });
  const githubRepositoriesQuery = useQuery({
    queryKey: ['github-repositories'],
    queryFn: () => fetchGitHubRepositories(100),
    enabled: Boolean(githubAdapterStatusQuery.data?.persistent),
    retry: 1
  });
  const githubRepositoryOwnersQuery = useQuery({
    queryKey: ['github-repository-owners'],
    queryFn: () => fetchGitHubRepositoryOwners(100),
    enabled: Boolean(githubAdapterStatusQuery.data?.persistent),
    retry: 1
  });
  const workerStatusQuery = useQuery({ queryKey: ['worker-status'], queryFn: fetchWorkerStatus, refetchInterval: globalPollInterval, retry: 1 });
  const workerEventsQuery = useQuery({ queryKey: ['worker-events'], queryFn: () => fetchWorkerEvents(8), refetchInterval: globalPollInterval, retry: 1 });

  const projects = projectsQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];
  const approvals = approvalsQuery.data ?? [];
  const notificationSettings = notificationSettingsQuery.data;
  const providerStatus = providerStatusQuery.data;
  const githubAdapterStatus = githubAdapterStatusQuery.data;
  const githubRepositories = githubRepositoriesQuery.data ?? [];
  const githubRepositoryOwners = githubRepositoryOwnersQuery.data ?? [];

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);
  const projectRoadmapQuery = useQuery({
    queryKey: ['projects', selectedProject?.id, 'roadmap'],
    queryFn: () => fetchProjectRoadmap(selectedProject?.id ?? ''),
    enabled: Boolean(selectedProject?.id),
    retry: 1
  });

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [selectedTaskId, tasks]);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0], [selectedTaskId, tasks]);
  const selectedTaskIsActive = activeStatuses.has(selectedTask?.status ?? 'draft');
  const selectedTaskPollInterval = selectedTaskIsActive ? (taskRealtimeState === 'connected' ? false : 15000) : false;

  const logsQuery = useQuery({
    queryKey: ['tasks', selectedTask?.id, 'logs'],
    queryFn: () => fetchTaskLogs(selectedTask?.id ?? ''),
    enabled: Boolean(selectedTask?.id),
    refetchInterval: selectedTaskPollInterval,
    retry: 1
  });
  const diffQuery = useQuery({
    queryKey: ['tasks', selectedTask?.id, 'diff'],
    queryFn: () => fetchTaskDiff(selectedTask?.id ?? ''),
    enabled: Boolean(selectedTask?.id),
    refetchInterval: selectedTaskPollInterval,
    retry: 1
  });
  const usageQuery = useQuery({
    queryKey: ['tasks', selectedTask?.id, 'usage'],
    queryFn: () => fetchTaskRuns(selectedTask?.id ?? ''),
    enabled: Boolean(selectedTask?.id),
    refetchInterval: selectedTaskPollInterval,
    retry: 1
  });
  const queueQuery = useQuery({
    queryKey: ['tasks', selectedTask?.id, 'queue'],
    queryFn: () => fetchTaskQueue(selectedTask?.id ?? ''),
    enabled: Boolean(selectedTask?.id),
    refetchInterval: selectedTaskPollInterval,
    retry: 1
  });

  useEffect(() => {
    const unsubscribe = subscribeRealtime(undefined, {
      onMessage: (message: RealtimeMessage) => {
        if (message.type !== 'audit_event') {
          return;
        }

        const event = message.event;

        queryClient.invalidateQueries({ queryKey: ['tasks'] });
        queryClient.invalidateQueries({ queryKey: ['approvals'] });
        queryClient.invalidateQueries({ queryKey: ['worker-status'] });
        queryClient.invalidateQueries({ queryKey: ['worker-events'] });

        if (event.taskId) {
          queryClient.setQueryData<AuditEventApi[]>(
            ['tasks', event.taskId, 'logs'],
            (current) => appendAuditEvent(current, event)
          );
          if (
            event.eventType === 'task_iteration_started'
            || event.eventType.startsWith('task_status_')
            || event.eventType === 'task_claimed'
            || event.eventType === 'task_enqueued'
          ) {
            queryClient.invalidateQueries({ queryKey: ['tasks', event.taskId, 'diff'] });
            queryClient.invalidateQueries({ queryKey: ['tasks', event.taskId, 'usage'] });
            queryClient.invalidateQueries({ queryKey: ['tasks', event.taskId, 'queue'] });
          }
        }
      },
      onOpen: () => {
        setGlobalRealtimeState('connected');
      },
      onClose: () => {
        setGlobalRealtimeState('reconnecting');
        queryClient.invalidateQueries({ queryKey: ['tasks'] });
        queryClient.invalidateQueries({ queryKey: ['approvals'] });
        queryClient.invalidateQueries({ queryKey: ['worker-status'] });
        queryClient.invalidateQueries({ queryKey: ['worker-events'] });
      },
      onError: () => {
        setGlobalRealtimeState('fallback');
      },
      onStateChange: (state) => {
        setGlobalRealtimeState(mapRealtimeUiState(state));
      },
      onMetaChange: (meta) => {
        setGlobalRealtimeMeta(meta);
      }
    });

    return () => {
      setGlobalRealtimeState('fallback');
      setGlobalRealtimeMeta({ state: 'idle' });
      unsubscribe();
    };
  }, [queryClient]);

  useEffect(() => {
    if (!selectedTask?.id) {
      return;
    }

    queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'logs'] });
    queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'diff'] });
    queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'usage'] });
    queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'queue'] });
  }, [queryClient, selectedTask?.id, selectedTask?.status, selectedTask?.updatedAt]);

  useEffect(() => {
    if (!selectedTask?.id) {
      setTaskRealtimeState('fallback');
      setTaskRealtimeMeta({ state: 'idle' });
      return;
    }

    const unsubscribe = subscribeRealtime(selectedTask.id, {
      onMessage: (message: RealtimeMessage) => {
        if (message.type !== 'audit_event') {
          return;
        }

        if (message.event.taskId !== selectedTask.id) {
          return;
        }

        if (message.event.eventType === 'task_iteration_started' || message.event.eventType.startsWith('task_status_')) {
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'diff'] });
          queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'usage'] });
          queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'queue'] });
          queryClient.invalidateQueries({ queryKey: ['worker-status'] });
          queryClient.invalidateQueries({ queryKey: ['worker-events'] });
        }
      },
      onOpen: () => {
        setTaskRealtimeState('connected');
      },
      onClose: () => {
        setTaskRealtimeState('reconnecting');
        queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'logs'] });
        queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'diff'] });
        queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'usage'] });
        queryClient.invalidateQueries({ queryKey: ['tasks', selectedTask.id, 'queue'] });
        queryClient.invalidateQueries({ queryKey: ['worker-status'] });
      },
      onError: () => {
        setTaskRealtimeState('fallback');
      },
      onStateChange: (state) => {
        setTaskRealtimeState(mapRealtimeUiState(state));
      },
      onMetaChange: (meta) => {
        setTaskRealtimeMeta(meta);
      }
    });

    return () => {
      setTaskRealtimeState('fallback');
      setTaskRealtimeMeta({ state: 'idle' });
      unsubscribe();
    };
  }, [queryClient, selectedTask?.id]);

  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const activeTasks = tasks.filter((task) => !terminalStatuses.has(task.status));
  const hasApiError = Boolean(projectsQuery.error || tasksQuery.error || approvalsQuery.error);

  function invalidateTaskData(taskId?: string) {
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['approvals'] });
    if (taskId) {
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'logs'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'diff'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'usage'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'queue'] });
    }
  }

  function invalidateProjectData(projectId?: string) {
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    if (projectId) {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'roadmap'] });
    }
  }

  const createTaskMutation = useMutation({
    mutationFn: createTaskRequest,
    onSuccess: (task) => {
      invalidateTaskData(task.id);
      setSelectedTaskId(task.id);
      setView('tasks');
    }
  });

  const workerQueueControlMutation = useMutation({
    mutationFn: setWorkerQueuePaused,
    onSuccess: (status) => {
      queryClient.setQueryData(['worker-status'], status);
      queryClient.invalidateQueries({ queryKey: ['worker-events'] });
    }
  });

  const createProjectMutation = useMutation({
    mutationFn: createProjectRequest,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setSelectedProjectId(project.id);
      setView('projects');
    }
  });

  const assignProjectRepositoryMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: AssignProjectRepositoryRequest }) =>
      assignProjectRepositoryRequest(projectId, input),
    onSuccess: () => {
      invalidateProjectData();
    }
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: UpdateProjectRequest }) => updateProjectRequest(projectId, input),
    onSuccess: (project) => {
      queryClient.setQueryData<ProjectSummary[]>(['projects'], (projects) =>
        projects?.map((candidate) => candidate.id === project.id ? project : candidate)
      );
      invalidateProjectData(project.id);
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: DeleteProjectRequest }) =>
      deleteProjectRequest(projectId, input),
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectSummary[]>(['projects'], (currentProjects) =>
        currentProjects?.filter((project) => project.id !== result.projectId)
      );
      queryClient.setQueryData<TaskSummary[]>(['tasks'], (currentTasks) =>
        currentTasks?.filter((task) => task.projectId !== result.projectId)
      );
      queryClient.removeQueries({ queryKey: ['projects', result.projectId] });
      setSelectedProjectId('');
      invalidateProjectData();
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    }
  });

  const updateProjectAutomationMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: UpdateProjectRequest }) => updateProjectRequest(projectId, input),
    onSuccess: (project) => {
      queryClient.setQueryData<ProjectSummary[]>(['projects'], (projects) =>
        projects?.map((candidate) => candidate.id === project.id ? project : candidate)
      );
      invalidateProjectData(project.id);
    }
  });

  const generateProjectRoadmapMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input?: GenerateProjectRoadmapRequest }) =>
      generateProjectRoadmapRequest(projectId, input),
    onSuccess: (roadmap) => {
      invalidateProjectData(roadmap.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    }
  });

  const decideProjectRoadmapExtensionMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: DecideProjectRoadmapExtensionRequest }) =>
      decideProjectRoadmapExtensionRequest(projectId, input),
    onSuccess: (roadmap) => {
      invalidateProjectData(roadmap.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    }
  });

  const startTaskMutation = useMutation({
    mutationFn: startTaskRequest,
    onSuccess: (task) => {
      invalidateTaskData(task.id);
      setSelectedTaskId(task.id);
    }
  });

  const cancelTaskMutation = useMutation({
    mutationFn: cancelTaskRequest,
    onSuccess: (task) => invalidateTaskData(task.id)
  });

  const retryTaskMutation = useMutation({
    mutationFn: retryTaskRequest,
    onSuccess: (task) => {
      invalidateTaskData(task.id);
      setSelectedTaskId(task.id);
    }
  });

  const completeTaskMutation = useMutation({
    mutationFn: completeTaskRequest,
    onSuccess: (task) => {
      invalidateTaskData(task.id);
      setSelectedTaskId(task.id);
    }
  });

  const resolveApprovalMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'rejected' }) => resolveApprovalRequest(id, status),
    onSuccess: () => invalidateTaskData(selectedTask?.id)
  });

  const subscribeNotificationsMutation = useMutation({
    mutationFn: async () => {
      const publicKey = await fetchNotificationVapidPublicKey();
      return subscribeForPushNotifications({
        vapidPublicKey: publicKey,
        deviceName: navigator.userAgent.includes('Mobile') ? 'mobile-web' : 'desktop-web',
        onSubscribe: async (payload) => {
          await subscribeNotification(payload);
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    }
  });

  const unsubscribeNotificationsMutation = useMutation({
    mutationFn: async () =>
      unsubscribeFromPushNotifications({
        onUnsubscribe: async (endpoint) => {
          await unsubscribeNotification(endpoint);
        }
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    }
  });

  const updateNotificationSettingsMutation = useMutation({
    mutationFn: (input: Partial<NotificationSettingsApi['settings']>) => updateNotificationSettings(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    }
  });

  const providerConnectMutation = useMutation({
    mutationFn: (input: ProviderConnectRequest) => connectProvider(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-status'] });
    }
  });

  const providerDeleteMutation = useMutation({
    mutationFn: deleteProviderConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-status'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });

  const codexOAuthStartMutation = useMutation({
    mutationFn: (input: { name?: string }) => startCodexOAuth(input)
  });

  const codexOAuthCompleteMutation = useMutation({
    mutationFn: (input: { loginId: string; model: string; name?: string; isDefault?: boolean }) => completeCodexOAuth(input),
    onSuccess: (result) => {
      if (result.completed) {
        queryClient.invalidateQueries({ queryKey: ['provider-status'] });
      }
    }
  });

  const githubAdapterConnectMutation = useMutation({
    mutationFn: (input: GitHubAdapterConnectRequest) => connectGitHubAdapter(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['github-adapter-status'] });
      queryClient.invalidateQueries({ queryKey: ['github-repositories'] });
      queryClient.invalidateQueries({ queryKey: ['github-repository-owners'] });
      queryClient.invalidateQueries({ queryKey: ['provider-status'] });
    }
  });

  const githubAdapterDisconnectMutation = useMutation({
    mutationFn: disconnectGitHubAdapter,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['github-adapter-status'] });
      queryClient.removeQueries({ queryKey: ['github-repositories'] });
      queryClient.removeQueries({ queryKey: ['github-repository-owners'] });
      queryClient.invalidateQueries({ queryKey: ['provider-status'] });
    }
  });
  const githubAdapterMessage = githubAdapterConnectMutation.data?.check.repository
    ? `Ověřeno: ${githubAdapterConnectMutation.data.check.repository.fullName}`
    : githubAdapterConnectMutation.data?.check.rateLimit
      ? `Ověřeno přes rate limit, zbývá ${githubAdapterConnectMutation.data.check.rateLimit.remaining}/${githubAdapterConnectMutation.data.check.rateLimit.limit}`
      : undefined;
  const githubAdapterError = githubAdapterConnectMutation.error ?? githubAdapterDisconnectMutation.error;

  function createTask(formData: FormData) {
    const scopeFiles = String(formData.get('scopeFiles') || '')
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
    const acceptanceCriteria = String(formData.get('acceptanceCriteria') || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    const input: CreateTaskRequest = {
      projectId: String(formData.get('projectId')),
      title: String(formData.get('title')),
      prompt: String(formData.get('prompt')),
      priority: String(formData.get('priority') || 'medium') as CreateTaskRequest['priority'],
      scopeFiles,
      acceptanceCriteria,
      runtimeSummary: String(formData.get('runtimeSummary') || '').trim() || undefined,
      mode: String(formData.get('mode')) as CreateTaskRequest['mode'],
      maxBudgetUsd: Number(formData.get('maxBudgetUsd') || 2),
      maxIterations: Number(formData.get('maxIterations') || 10)
    };
    createTaskMutation.mutate(input);
  }

  function createProject(formData: FormData) {
    const repositoryMode = String(formData.get('repositoryMode') || 'existing') as CreateProjectRequest['repositoryMode'];
    const branchMode = repositoryMode === 'create'
      ? 'create'
      : String(formData.get('branchMode') || 'existing') as CreateProjectRequest['branchMode'];
    const branchName = String(formData.get(repositoryMode === 'create' ? 'newDefaultBranch' : 'branchName') || '').trim();
    const defaultBranch = repositoryMode === 'create'
      ? branchName || 'main'
      : branchMode === 'create'
        ? branchName || 'main'
        : String(formData.get('defaultBranch') || 'main');
    const input: CreateProjectRequest = {
      name: String(formData.get('name')),
      slug: String(formData.get('slug')),
      repositoryMode,
      githubOwner: String(formData.get(repositoryMode === 'create' ? 'newGithubOwner' : 'githubOwner') || '').trim() || undefined,
      githubRepo: String(formData.get(repositoryMode === 'create' ? 'newGithubRepo' : 'githubRepo') || '').trim() || undefined,
      defaultBranch,
      branchMode,
      branchName: branchMode === 'create' ? branchName || defaultBranch : undefined,
      configYaml: String(formData.get('configYaml') || '') || undefined,
      brief: String(formData.get('brief') || '').trim() || undefined,
      repositoryPrivate: formData.get('repositoryPrivate') === 'on',
      repositoryDescription: String(formData.get('repositoryDescription') || '').trim() || undefined
    };
    createProjectMutation.mutate(input);
  }

  function assignProjectRepository(projectId: string, formData: FormData) {
    const mode = String(formData.get('repositoryMode') || 'existing') as AssignProjectRepositoryRequest['mode'];
    const branchMode = mode === 'create'
      ? 'create'
      : String(formData.get('branchMode') || 'existing') as AssignProjectRepositoryRequest['branchMode'];
    const branchName = String(formData.get(mode === 'create' ? 'newDefaultBranch' : 'branchName') || '').trim();
    const defaultBranch = mode === 'create'
      ? branchName || 'main'
      : branchMode === 'create'
        ? branchName || 'main'
        : String(formData.get('defaultBranch') || '').trim() || undefined;
    const input: AssignProjectRepositoryRequest = {
      mode,
      owner: String(formData.get(mode === 'create' ? 'newGithubOwner' : 'githubOwner') || '').trim() || undefined,
      repo: String(formData.get(mode === 'create' ? 'newGithubRepo' : 'githubRepo') || '').trim(),
      defaultBranch,
      branchMode,
      branchName: branchMode === 'create' ? branchName || defaultBranch : undefined,
      private: formData.get('repositoryPrivate') === 'on',
      description: String(formData.get('repositoryDescription') || '').trim() || undefined
    };

    assignProjectRepositoryMutation.mutate({ projectId, input });
  }

  function updateProjectBrief(projectId: string, formData: FormData) {
    updateProjectMutation.reset();
    const brief = String(formData.get('brief') || '').trim();
    updateProjectMutation.mutate({
      projectId,
      input: {
        brief: brief || null
      }
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navigace">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <div>
            <strong>ForgeMind</strong>
            <span>Mobile</span>
          </div>
        </div>
        <NavButton active={view === 'tasks'} icon={LayoutList} label="Tasks" onClick={() => setView('tasks')} />
        <NavButton active={view === 'new-task'} icon={Plus} label="New task" onClick={() => setView('new-task')} />
        <NavButton active={view === 'approvals'} icon={ShieldCheck} label={`Approvals ${pendingApprovals.length}`} onClick={() => setView('approvals')} />
        <NavButton active={view === 'projects'} icon={FolderPlus} label="Projects" onClick={() => setView('projects')} />
        <NavButton active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p>{projects.length} projekty</p>
            <h1>{viewTitle(view)}</h1>
            <p>
              Worker: {workerStatusQuery.data?.state ?? 'unknown'} · queue {workerStatusQuery.data?.queuedTaskCount ?? 0} · active {workerStatusQuery.data?.activeTaskCount ?? 0} · {workerStatusQuery.data?.queuePaused ? 'fronta pozastavena' : 'fronta aktivní'}
            </p>
            <div className="connection-indicators" aria-label="Realtime status">
              <RealtimeStatusBadge label="Global feed" state={globalRealtimeState} meta={globalRealtimeMeta} />
              {view === 'tasks' && selectedTask ? <RealtimeStatusBadge label="Task feed" state={taskRealtimeState} meta={taskRealtimeMeta} /> : null}
            </div>
          </div>
          <div className="topbar-actions">
            <button
              className="secondary-action"
              type="button"
              disabled={!workerStatusQuery.data || workerQueueControlMutation.isPending}
              onClick={() => workerQueueControlMutation.mutate(!workerStatusQuery.data?.queuePaused)}
            >
              {workerStatusQuery.data?.queuePaused ? <Play size={18} /> : <Pause size={18} />}
              {workerStatusQuery.data?.queuePaused ? 'Obnovit frontu' : 'Pozastavit frontu'}
            </button>
            {view !== 'new-task' ? (
              <button className="primary-action" type="button" onClick={() => setView('new-task')}>
                <Plus size={18} />
                Nový task
              </button>
            ) : null}
          </div>
        </header>

        {hasApiError ? <div className="error-banner">API není dostupné, zobrazuji lokální fallback.</div> : null}
        {workerQueueControlMutation.error ? (
          <div className="error-banner">Změna stavu fronty selhala: {workerQueueControlMutation.error.message}</div>
        ) : null}

        {view === 'tasks' ? (
          <section className="workspace">
            <div className="task-list" aria-label="Seznam tasků">
              <MetricRow label="Aktivní tasky" value={String(activeTasks.length)} />
              <MetricRow label="Čekající approvals" value={String(pendingApprovals.length)} tone={pendingApprovals.length ? 'warning' : 'ok'} />
              <MetricRow label="Worker events" value={String(workerEventsQuery.data?.length ?? 0)} />
              <div className="timeline" aria-label="Worker feed">
                {(workerEventsQuery.data ?? []).slice(0, 4).map((event) => (
                  <div className="timeline-row" key={event.id}>
                    <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                    <strong>{event.eventType}</strong>
                  </div>
                ))}
              </div>
              {tasksQuery.isLoading ? <div className="loading-line">Načítám tasky...</div> : null}
              {tasks.length === 0 ? <EmptyState onCreate={() => setView('new-task')} /> : null}
              {tasks.map((task) => (
                <TaskButton key={task.id} task={task} selected={task.id === selectedTask?.id} onClick={() => setSelectedTaskId(task.id)} />
              ))}
            </div>
            {selectedTask ? (
              <TaskDetail
                projects={projects}
                task={selectedTask}
                logs={logsQuery.data ?? []}
                diff={diffQuery.data}
                usage={usageQuery.data}
                queue={queueQuery.data}
                workerStatus={workerStatusQuery.data}
                realtimeState={taskRealtimeState}
                realtimeMeta={taskRealtimeMeta}
                busy={
                  startTaskMutation.isPending
                  || cancelTaskMutation.isPending
                  || retryTaskMutation.isPending
                  || completeTaskMutation.isPending
                }
                onStart={(taskId) => startTaskMutation.mutate(taskId)}
                onCancel={(taskId) => cancelTaskMutation.mutate(taskId)}
                onRetry={(taskId) => retryTaskMutation.mutate(taskId)}
                onComplete={(taskId) => completeTaskMutation.mutate(taskId)}
              />
            ) : null}
          </section>
        ) : null}

        {view === 'new-task' ? <NewTaskForm projects={projects} saving={createTaskMutation.isPending} onSubmit={createTask} /> : null}

        {view === 'approvals' ? (
          <section className="approval-grid">
            {pendingApprovals.length === 0 ? <div className="empty-state approval-section-heading">Žádné schválení nečeká.</div> : null}
            {pendingApprovals.map((approval) => (
              <ApprovalPanel
                key={approval.id}
                approval={approval}
                tasks={tasks}
                resolving={resolveApprovalMutation.isPending}
                onResolve={(id, status) => resolveApprovalMutation.mutate({ id, status })}
              />
            ))}
            {approvals.some((approval) => approval.status !== 'pending') ? <h2 className="approval-section-heading">Historie</h2> : null}
            {approvals.filter((approval) => approval.status !== 'pending').map((approval) => (
              <ApprovalPanel
                key={approval.id}
                approval={approval}
                tasks={tasks}
                resolving={resolveApprovalMutation.isPending}
                onResolve={(id, status) => resolveApprovalMutation.mutate({ id, status })}
              />
            ))}
          </section>
        ) : null}

        {view === 'projects' ? (
          <ProjectsPanel
            projects={projects}
            tasks={tasks}
            selectedProjectId={selectedProject?.id}
            onSelectProject={setSelectedProjectId}
            providerStatus={providerStatus}
            roadmap={projectRoadmapQuery.data}
            roadmapLoading={projectRoadmapQuery.isLoading}
            roadmapError={
              generateProjectRoadmapMutation.error
                ? formatUiError(generateProjectRoadmapMutation.error)
                : projectRoadmapQuery.error
                  ? formatUiError(projectRoadmapQuery.error)
                  : undefined
            }
            saving={createProjectMutation.isPending}
            updatingProject={updateProjectMutation.isPending}
            updateProjectError={updateProjectMutation.error ? formatUiError(updateProjectMutation.error) : undefined}
            projectUpdated={updateProjectMutation.isSuccess}
            updatingAutomation={updateProjectAutomationMutation.isPending}
            automationUpdateError={updateProjectAutomationMutation.error ? formatUiError(updateProjectAutomationMutation.error) : undefined}
            automationUpdated={updateProjectAutomationMutation.isSuccess}
            assigningRepository={assignProjectRepositoryMutation.isPending}
            generatingRoadmap={generateProjectRoadmapMutation.isPending}
            decidingExtension={decideProjectRoadmapExtensionMutation.isPending}
            deletingProject={deleteProjectMutation.isPending}
            deleteProjectError={deleteProjectMutation.error ? formatUiError(deleteProjectMutation.error) : undefined}
            onCreateProject={createProject}
            onAssignProjectRepository={assignProjectRepository}
            onUpdateProjectBrief={updateProjectBrief}
            onUpdateProjectAutomation={(projectId, input) => {
              updateProjectAutomationMutation.reset();
              updateProjectAutomationMutation.mutate({ projectId, input });
            }}
            onGenerateRoadmap={(projectId, input) => generateProjectRoadmapMutation.mutate({ projectId, input })}
            onDecideExtension={(projectId, input) => decideProjectRoadmapExtensionMutation.mutate({ projectId, input })}
            onDeleteProject={(projectId, input) => {
              deleteProjectMutation.reset();
              deleteProjectMutation.mutate({ projectId, input });
            }}
            githubRepositories={githubRepositories}
            githubRepositoriesLoading={githubRepositoriesQuery.isLoading}
            githubRepositoriesError={githubRepositoriesQuery.error ? formatUiError(githubRepositoriesQuery.error) : undefined}
            githubRepositoryOwners={githubRepositoryOwners}
            githubRepositoryOwnersLoading={githubRepositoryOwnersQuery.isLoading}
            githubRepositoryOwnersError={githubRepositoryOwnersQuery.error ? formatUiError(githubRepositoryOwnersQuery.error) : undefined}
          />
        ) : null}

        {view === 'settings' ? (
          <SettingsPanel
            githubAdapterStatus={githubAdapterStatus}
            githubAdapterLoading={githubAdapterStatusQuery.isLoading}
            githubAdapterBusy={githubAdapterConnectMutation.isPending || githubAdapterDisconnectMutation.isPending}
            githubAdapterMessage={githubAdapterMessage}
            githubAdapterError={githubAdapterError ? formatUiError(githubAdapterError) : undefined}
            onGitHubAdapterConnect={(input) => githubAdapterConnectMutation.mutate(input)}
            onGitHubAdapterDisconnect={() => githubAdapterDisconnectMutation.mutate()}
            providerStatus={providerStatus}
            providerLoading={providerStatusQuery.isLoading}
            providerBusy={
              providerConnectMutation.isPending
              || codexOAuthStartMutation.isPending
              || codexOAuthCompleteMutation.isPending
              || providerDeleteMutation.isPending
            }
            providerError={
              providerConnectMutation.error
                ? formatUiError(providerConnectMutation.error)
                : codexOAuthStartMutation.error
                  ? formatUiError(codexOAuthStartMutation.error)
                  : codexOAuthCompleteMutation.error
                    ? formatUiError(codexOAuthCompleteMutation.error)
                    : providerDeleteMutation.error
                      ? formatUiError(providerDeleteMutation.error)
                      : undefined
            }
            onProviderConnect={(input) => providerConnectMutation.mutate(input)}
            onProviderDelete={(connectionId) => providerDeleteMutation.mutate(connectionId)}
            onCodexOAuthStart={(name) => codexOAuthStartMutation.mutateAsync({ name })}
            onCodexOAuthComplete={(loginId, model, name, isDefault) => codexOAuthCompleteMutation.mutateAsync({ loginId, model, name, isDefault })}
            notificationSettings={notificationSettings}
            notificationsLoading={notificationSettingsQuery.isLoading}
            notificationsBusy={
              subscribeNotificationsMutation.isPending ||
              unsubscribeNotificationsMutation.isPending ||
              updateNotificationSettingsMutation.isPending
            }
            notificationsError={
              subscribeNotificationsMutation.error
                ? formatUiError(subscribeNotificationsMutation.error)
                : unsubscribeNotificationsMutation.error
                  ? formatUiError(unsubscribeNotificationsMutation.error)
                  : updateNotificationSettingsMutation.error
                    ? formatUiError(updateNotificationSettingsMutation.error)
                    : undefined
            }
            onSubscribeNotifications={() => subscribeNotificationsMutation.mutate()}
            onUnsubscribeNotifications={() => unsubscribeNotificationsMutation.mutate()}
            onUpdateNotificationSettings={(input) => updateNotificationSettingsMutation.mutate(input)}
          />
        ) : null}
      </main>

      <nav className="bottom-nav" aria-label="Mobilní navigace">
        <NavButton compact active={view === 'tasks'} icon={LayoutList} label="Tasks" onClick={() => setView('tasks')} />
        <NavButton compact active={view === 'new-task'} icon={Plus} label="New" onClick={() => setView('new-task')} />
        <NavButton compact active={view === 'approvals'} icon={ShieldCheck} label="Approve" onClick={() => setView('approvals')} />
        <NavButton compact active={view === 'projects'} icon={FolderPlus} label="Projects" onClick={() => setView('projects')} />
        <NavButton compact active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
      </nav>
    </div>
  );
}

function viewTitle(view: View) {
  if (view === 'new-task') return 'Nový úkol';
  if (view === 'approvals') return 'Schválení';
  if (view === 'projects') return 'Projekty';
  if (view === 'settings') return 'Nastavení';
  return 'Přehled tasků';
}

function RealtimeStatusBadge({
  label,
  state,
  meta
}: {
  label: string;
  state: RealtimeUiState;
  meta: RealtimeConnectionMeta;
}) {
  return (
    <span className={`connection-badge ${state}`}>
      <strong>{label}</strong>
      <span>{formatRealtimeState(state)}</span>
      {meta.lastHeartbeatAt ? <small>{formatProgressTime(meta.lastHeartbeatAt)}</small> : null}
    </span>
  );
}

function formatUiError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function NavButton(props: { active: boolean; compact?: boolean; icon: typeof LayoutList; label: string; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button className={props.active ? 'nav-button active' : 'nav-button'} type="button" onClick={props.onClick} title={props.label}>
      <Icon size={props.compact ? 20 : 18} />
      <span>{props.label}</span>
    </button>
  );
}

function RepositoryPicker(props: {
  repositories: GitHubRepositoryApi[];
  loading: boolean;
  error?: string;
  selectedFullName?: string;
  compact?: boolean;
  onRepositoryChange?: (repository?: GitHubRepositoryApi) => void;
}) {
  const fallbackFullName = props.repositories[0]?.fullName ?? '';
  const [selectedFullName, setSelectedFullName] = useState(props.selectedFullName ?? fallbackFullName);

  useEffect(() => {
    const candidate = props.selectedFullName ?? fallbackFullName;
    const selectedExists = props.repositories.some((repository) => repository.fullName === selectedFullName);
    if (candidate && (!selectedFullName || !selectedExists)) {
      setSelectedFullName(candidate);
    }
  }, [fallbackFullName, props.repositories, props.selectedFullName, selectedFullName]);

  const selectedRepository = props.repositories.find((repository) => repository.fullName === selectedFullName);
  const onRepositoryChange = props.onRepositoryChange;

  useEffect(() => {
    onRepositoryChange?.(selectedRepository);
  }, [onRepositoryChange, selectedRepository?.fullName]);

  return (
    <label className={props.compact ? undefined : 'wide'}>
      GitHub repository
      <select
        name="githubRepositoryFullName"
        value={selectedFullName}
        onChange={(event) => setSelectedFullName(event.target.value)}
        disabled={props.loading || props.repositories.length === 0}
      >
        <option value="">{props.loading ? 'Načítám repozitáře...' : 'Vyber repozitář'}</option>
        {props.repositories.map((repository) => (
          <option key={repository.fullName} value={repository.fullName}>
            {repository.fullName}{repository.private ? ' private' : ''}
          </option>
        ))}
      </select>
      <input type="hidden" name="githubOwner" value={selectedRepository?.owner ?? ''} />
      <input type="hidden" name="githubRepo" value={selectedRepository?.repo ?? ''} />
      {props.error ? <span className="inline-error">{props.error}</span> : null}
    </label>
  );
}

function RepositoryOwnerPicker(props: {
  owners: GitHubRepositoryOwnerApi[];
  loading: boolean;
  error?: string;
  selectedOwner?: string;
  compact?: boolean;
}) {
  const fallbackOwner = props.selectedOwner && props.owners.some((owner) => owner.login === props.selectedOwner)
    ? props.selectedOwner
    : props.owners[0]?.login ?? '';
  const [selectedOwner, setSelectedOwner] = useState(fallbackOwner);

  useEffect(() => {
    const selectedExists = props.owners.some((owner) => owner.login === selectedOwner);
    if (fallbackOwner && (!selectedOwner || !selectedExists)) {
      setSelectedOwner(fallbackOwner);
      return;
    }
    if (!fallbackOwner && selectedOwner) {
      setSelectedOwner('');
    }
  }, [fallbackOwner, props.owners, selectedOwner]);

  return (
    <label className={props.compact ? undefined : 'wide'}>
      Owner / organizace
      <select
        name="newGithubOwner"
        value={selectedOwner}
        onChange={(event) => setSelectedOwner(event.target.value)}
        disabled={props.loading || props.owners.length === 0}
        required
      >
        <option value="">{props.loading ? 'Načítám owner/organizace...' : 'Vyber owner/organizaci'}</option>
        {props.owners.map((owner) => (
          <option key={owner.login} value={owner.login}>
            {owner.login}{owner.kind === 'organization' ? ' organization' : ' user'}
          </option>
        ))}
      </select>
      {props.error ? <span className="inline-error">{props.error}</span> : null}
    </label>
  );
}

function BranchPicker(props: {
  owner?: string;
  repo?: string;
  selectedBranch?: string;
  compact?: boolean;
}) {
  const enabled = Boolean(props.owner && props.repo);
  const branchesQuery = useQuery({
    queryKey: ['github-branches', props.owner, props.repo],
    queryFn: () => fetchGitHubBranches(props.owner ?? '', props.repo ?? '', 100),
    enabled,
    retry: 1
  });
  const branches: GitHubBranchApi[] = branchesQuery.data ?? [];
  const fallbackBranch = props.selectedBranch ?? branches[0]?.name ?? '';
  const [selectedBranch, setSelectedBranch] = useState(fallbackBranch);

  useEffect(() => {
    const selectedExists = branches.some((branch) => branch.name === selectedBranch);
    const preferredExists = props.selectedBranch ? branches.some((branch) => branch.name === props.selectedBranch) : false;
    const candidate = preferredExists ? props.selectedBranch ?? '' : fallbackBranch;
    if (candidate && (!selectedBranch || !selectedExists)) {
      setSelectedBranch(candidate);
      return;
    }
    if (!candidate && selectedBranch) {
      setSelectedBranch('');
    }
  }, [branches, fallbackBranch, props.selectedBranch, selectedBranch]);

  return (
    <label className={props.compact ? undefined : 'wide'}>
      GitHub branch
      <select
        name="defaultBranch"
        value={selectedBranch}
        onChange={(event) => setSelectedBranch(event.target.value)}
        disabled={!enabled || branchesQuery.isLoading || branches.length === 0}
      >
        <option value="">
          {!enabled ? 'Nejdriv vyber repozitar' : branchesQuery.isLoading ? 'Nacitam branche...' : 'Vyber branch'}
        </option>
        {branches.map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}{branch.protected ? ' protected' : ''}
          </option>
        ))}
      </select>
      {branchesQuery.error ? <span className="inline-error">{formatUiError(branchesQuery.error)}</span> : null}
    </label>
  );
}

function ProjectRepositoryAssignmentForm(props: {
  project: ProjectSummary;
  repositories: GitHubRepositoryApi[];
  repositoryOwners: GitHubRepositoryOwnerApi[];
  loading: boolean;
  error?: string;
  ownersLoading: boolean;
  ownersError?: string;
  assigningRepository: boolean;
  onAssignProjectRepository: (projectId: string, formData: FormData) => void;
}) {
  const [repositoryMode, setRepositoryMode] = useState<'existing' | 'create'>('existing');
  const [branchMode, setBranchMode] = useState<'existing' | 'create'>('existing');
  const [selectedRepository, setSelectedRepository] = useState<GitHubRepositoryApi | undefined>();
  const selectedFullName = props.project.githubOwner && props.project.githubRepo
    ? `${props.project.githubOwner}/${props.project.githubRepo}`
    : undefined;

  return (
    <form
      className="repo-assignment-form wide"
      onSubmit={(event) => {
        event.preventDefault();
        props.onAssignProjectRepository(props.project.id, new FormData(event.currentTarget));
      }}
    >
      <select
        name="repositoryMode"
        value={repositoryMode}
        onChange={(event) => {
          const mode = event.target.value as 'existing' | 'create';
          setRepositoryMode(mode);
          setBranchMode(mode === 'create' ? 'create' : 'existing');
        }}
      >
        <option value="existing">Přiřadit existující</option>
        <option value="create">Vytvořit nové</option>
      </select>
      {repositoryMode === 'existing' ? (
        <>
          <RepositoryPicker
            repositories={props.repositories}
            loading={props.loading}
            error={props.error}
            selectedFullName={selectedFullName}
            onRepositoryChange={setSelectedRepository}
            compact
          />
          <select
            name="branchMode"
            value={branchMode}
            onChange={(event) => setBranchMode(event.target.value as 'existing' | 'create')}
          >
            <option value="existing">Vybrat existující branch</option>
            <option value="create">Vytvořit nový branch</option>
          </select>
          {branchMode === 'existing' ? (
            <BranchPicker
              owner={selectedRepository?.owner}
              repo={selectedRepository?.repo}
              selectedBranch={props.project.defaultBranch}
              compact
            />
          ) : (
            <input name="branchName" placeholder="ai/novy-branch" required={branchMode === 'create'} />
          )}
        </>
      ) : (
        <>
          <RepositoryOwnerPicker
            owners={props.repositoryOwners}
            loading={props.ownersLoading}
            error={props.ownersError}
            selectedOwner={props.project.githubOwner}
            compact
          />
          <input name="newGithubRepo" placeholder="new repo" required={repositoryMode === 'create'} />
          <input name="newDefaultBranch" placeholder="main" defaultValue={props.project.defaultBranch} required={repositoryMode === 'create'} />
          <label className="toggle-row">
            <input name="repositoryPrivate" type="checkbox" defaultChecked />
            Private
          </label>
          <input name="repositoryDescription" placeholder="popis pro nové repo" />
        </>
      )}
      <button className="secondary-action" type="submit" disabled={props.assigningRepository}>
        Uložit repo
      </button>
    </form>
  );
}

function MetricRow(props: { label: string; value: string; tone?: 'ok' | 'warning' }) {
  return (
    <div className={props.tone === 'warning' ? 'metric warning' : 'metric'}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <strong>Žádné tasky</strong>
      <button className="secondary-action" type="button" onClick={onCreate}>
        <Plus size={18} />
        Vytvořit první
      </button>
    </div>
  );
}

function TaskButton(props: { task: TaskSummary; selected: boolean; onClick: () => void }) {
  const Icon = statusIcons[props.task.status];
  return (
    <button className={props.selected ? 'task-row selected' : 'task-row'} type="button" onClick={props.onClick}>
      <span className={`status-dot ${props.task.status}`}>
        <Icon size={16} />
      </span>
      <span>
        <strong>{props.task.title}</strong>
        <small>{props.task.currentStep}</small>
      </span>
      <ArrowRight size={16} />
    </button>
  );
}

interface TaskActivityEntry {
  id: string;
  createdAt: string;
  phase: string;
  attempt: number;
  state: 'started' | 'progress' | 'completed' | 'failed';
  title: string;
  detail?: string;
  operation?: string;
  kind: 'activity' | 'lifecycle' | 'stdout' | 'stderr' | 'workspace';
  elapsedMs: number;
}

function TaskActivityPanel(props: {
  task: TaskSummary;
  taskId: string;
  logs: AuditEventApi[];
  realtimeState: RealtimeUiState;
}) {
  const entries = useMemo(() => collectTaskActivityEntries(props.logs, props.taskId), [props.logs, props.taskId]);
  const latest = entries.at(-1);
  const taskIsActive = activeStatuses.has(props.task.status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!taskIsActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [taskIsActive]);

  const latestAt = latest ? Date.parse(latest.createdAt) : Date.parse(props.task.updatedAt);
  const silenceSeconds = Number.isNaN(latestAt) ? undefined : Math.max(0, Math.floor((now - latestAt) / 1_000));
  const currentTitle = latest?.title ?? statusLabels[props.task.status];
  const currentDetail = latest?.detail ?? props.task.currentStep;
  const activityState = latest?.state === 'failed'
    ? 'failed'
    : taskIsActive
      ? 'active'
      : props.task.status === 'completed' || props.task.status === 'ready_for_user_review'
        ? 'completed'
        : 'idle';
  const technicalEntries = entries.slice(-120);

  return (
    <div className="task-activity-panel">
      <div className={`current-activity ${activityState}`} aria-live="polite">
        <span className="activity-indicator" aria-hidden="true" />
        <div className="current-activity-content">
          <div className="current-activity-meta">
            <span>{formatPhase(latest?.phase ?? props.task.status)}</span>
            <span>{formatRealtimeState(props.realtimeState)}</span>
          </div>
          <strong>{currentTitle}</strong>
          {currentDetail ? <p>{truncateText(currentDetail, 320)}</p> : null}
          <small>
            {taskIsActive
              ? silenceSeconds !== undefined && silenceSeconds > 10
                ? `Proces stále běží · poslední aktivita před ${formatDurationSeconds(silenceSeconds)}`
                : `Poslední aktivita před ${formatDurationSeconds(silenceSeconds ?? 0)}`
              : latest?.elapsedMs
                ? `Dokončeno za ${formatElapsedTime(latest.elapsedMs)}`
                : statusLabels[props.task.status]}
          </small>
        </div>
      </div>

      <details className="activity-output-disclosure">
        <summary>
          <span>Technický výstup</span>
          <small>{entries.length} událostí</small>
          <ArrowDown size={17} />
        </summary>
        <div className="provider-activity-output">
          {technicalEntries.length === 0 ? (
            <div className="provider-activity-empty">Zatím bez průběžné aktivity.</div>
          ) : null}
          {technicalEntries.map((entry) => (
            <div className={`provider-activity-entry ${entry.kind} ${entry.state}`} key={entry.id}>
              <div className="provider-activity-meta">
                <time>{formatProgressTime(entry.createdAt)}</time>
                <span>{formatPhase(entry.phase)}</span>
                {entry.attempt > 0 ? <span>pokus {entry.attempt}</span> : null}
                <span>{entry.state}</span>
                {entry.elapsedMs > 0 ? <span>{formatElapsedTime(entry.elapsedMs)}</span> : null}
              </div>
              <strong>{entry.title}</strong>
              {entry.detail ? <pre>{entry.detail}</pre> : null}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function TaskDetail(props: {
  projects: ProjectSummary[];
  task: TaskSummary;
  logs: AuditEventApi[];
  diff?: TaskDiffApi;
  usage?: TaskUsageApi;
  queue?: TaskQueueApi;
  workerStatus?: WorkerStatusApi;
  realtimeState: RealtimeUiState;
  realtimeMeta: RealtimeConnectionMeta;
  busy: boolean;
  onStart: (taskId: string) => void;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onComplete: (taskId: string) => void;
}) {
  const project = props.projects.find((item) => item.id === props.task.projectId);
  const canRetry = terminalStatuses.has(props.task.status) || props.task.status === 'ready_for_user_review';
  const canCancel = !terminalStatuses.has(props.task.status) && props.task.status !== 'ready_for_user_review';
  const canComplete = props.task.status === 'ready_for_user_review';
  const latestRun = props.usage?.runs.at(-1);
  const latestError = resolveLatestTaskError(props.task.status, props.logs, latestRun);
  const queueLabel = formatQueueLabel(props.task, props.queue);
  const workflowItems = buildTaskWorkflow(props.task, props.logs);

  return (
    <article className="detail">
      <div className="detail-heading">
        <div>
          <span className={`badge ${props.task.status}`}>{statusLabels[props.task.status]}</span>
          <h2>{props.task.title}</h2>
          <p>{project?.name ?? 'Neznámý projekt'}</p>
        </div>
        <div className="branch">
          <GitBranch size={18} />
          <span>{props.task.branchName ?? 'branch zatím nevytvořena'}</span>
        </div>
      </div>

      <div className="task-overview-grid">
        <MetricBlock label="Aktualni krok" value={props.task.currentStep || statusLabels[props.task.status]} />
        <MetricBlock label="Pokusy" value={`${latestRun?.iterationCount ?? props.task.iterations}/${props.task.maxIterations}`} />
        <MetricBlock label="Zmeny" value={`${props.diff?.filesChanged ?? 0} souboru, +${props.diff?.insertions ?? 0} -${props.diff?.deletions ?? 0}`} />
        <MetricBlock
          label="Cena"
          value={props.usage?.actualCostUsd !== null && props.usage?.actualCostUsd !== undefined
            ? `$${props.usage.actualCostUsd.toFixed(4)}`
            : 'Neni dostupna'}
        />
      </div>

      {latestError ? (
        <section className="task-error" role="alert">
          <AlertTriangle size={20} />
          <div>
            <strong>Task skoncil chybou</strong>
            <pre>{latestError}</pre>
          </div>
        </section>
      ) : null}

      <section className="plain-section">
        <div className="section-heading">
          <div>
            <h3>Průběh tasku</h3>
            <p>Aktuální činnost a stav kroků od přípravy po předání výsledku.</p>
          </div>
          {props.task.status === 'submitted' ? <span className="queue-label">Fronta {queueLabel}</span> : null}
        </div>
        <TaskActivityPanel
          task={props.task}
          taskId={props.task.id}
          logs={props.logs}
          realtimeState={props.realtimeState}
        />
        <ol className="workflow-steps">
          {workflowItems.map((item) => {
            const StepIcon = item.state === 'completed' ? CheckCircle2 : item.state === 'failed' ? XCircle : item.icon;
            return (
              <li className={`workflow-step ${item.state}`} key={item.id}>
                <span className="workflow-icon"><StepIcon size={18} /></span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <details className="task-disclosure">
        <summary>
          <span><strong>Zadani tasku</strong><small>{truncateText(props.task.prompt, 180)}</small></span>
          <ArrowDown size={18} />
        </summary>
        <div className="task-disclosure-body task-brief"><p>{props.task.prompt}</p></div>
      </details>

      <details className="task-disclosure">
        <summary>
          <span><strong>Technicke detaily</strong><small>Logy, behy provideru, tokeny a stav workeru</small></span>
          <ArrowDown size={18} />
        </summary>
        <div className="task-disclosure-body technical-details">
          <dl className="technical-summary">
            <div><dt>Worker</dt><dd>{props.workerStatus ? `${props.workerStatus.state} | queue ${props.workerStatus.queuedTaskCount} | active ${props.workerStatus.activeTaskCount}` : 'unknown'}</dd></div>
            <div><dt>Realtime</dt><dd>{formatRealtimeState(props.realtimeState)} | {formatHeartbeatStatus(props.realtimeMeta)}</dd></div>
            <div><dt>Tokeny</dt><dd>{formatTokenUsage(props.usage)}</dd></div>
          </dl>
          <h4>Log</h4>
          <div className="timeline">
            {props.logs.length === 0 ? <span>Bez zaznamu.</span> : null}
            {props.logs.slice(-8).map((event) => <div className="timeline-row" key={event.id}><span>{new Date(event.createdAt).toLocaleTimeString()}</span><strong>{formatEventType(event.eventType)}</strong><small>{formatAuditPayload(event.payload, undefined)}</small></div>)}
          </div>
          <h4>Behy</h4>
          <div className="timeline">
            {props.usage?.runs.length ? null : <span>Zatim bez behu.</span>}
            {(props.usage?.runs ?? []).slice(-5).reverse().map((run) => <div className="timeline-row" key={run.id}><span>{run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : 'in-progress'}</span><strong>{formatRunTitle(run)}</strong><small>{formatRunDetail(run, undefined)}</small></div>)}
          </div>
        </div>
      </details>

      <div className="actions">
        <button className="primary-action" type="button" disabled={props.task.status !== 'draft' || props.busy} onClick={() => props.onStart(props.task.id)}>
          <Play size={18} />
          Spustit
        </button>
        <button className="primary-action" type="button" disabled={!canComplete || props.busy} onClick={() => props.onComplete(props.task.id)}>
          <CheckCircle2 size={18} />
          Mark as completed
        </button>
        <button className="secondary-action" type="button" disabled={!canRetry || props.busy} onClick={() => props.onRetry(props.task.id)}>
          <RotateCcw size={18} />
          Retry
        </button>
        <button className="danger-action" type="button" disabled={!canCancel || props.busy} onClick={() => props.onCancel(props.task.id)}>
          <Ban size={18} />
          Cancel
        </button>
        <a className="secondary-action" href={props.task.issueUrl ?? '#'} aria-disabled={!props.task.issueUrl}>
          <Github size={18} />
          Issue
        </a>
        <a className="secondary-action" href={props.task.pullRequestUrl ?? '#'} aria-disabled={!props.task.pullRequestUrl}>
          <ClipboardCheck size={18} />
          Draft PR
        </a>
      </div>
    </article>
  );
}

type TaskRunApi = TaskUsageApi['runs'][number];

type WorkflowStepState = 'pending' | 'active' | 'completed' | 'failed';

interface TaskWorkflowItem {
  id: string;
  label: string;
  detail: string;
  icon: typeof Clock3;
  state: WorkflowStepState;
}

interface WorkflowStageTiming {
  elapsedMs: number;
  attemptCount: number;
}

function buildTaskWorkflow(task: TaskSummary, logs: AuditEventApi[]): TaskWorkflowItem[] {
  const stages = [
    { id: 'prepare', label: 'Příprava', detail: 'Zařazení tasku a vytvoření plánu', icon: LayoutList },
    { id: 'github', label: 'GitHub', detail: 'Issue a pracovní branch', icon: GitBranch },
    { id: 'implementation', label: 'Implementace', detail: 'Změny prováděné AI providerem', icon: Activity },
    { id: 'validation', label: 'Validace', detail: 'Ověření akceptačních kritérií', icon: ClipboardCheck },
    { id: 'review', label: 'Review', detail: 'Kontrola výsledku a rizik', icon: ShieldCheck },
    { id: 'handoff', label: 'Předání', detail: 'Pull request a kontrola uživatelem', icon: CheckCircle2 }
  ] as const;
  const statusStage: Partial<Record<TaskSummary['status'], number>> = {
    draft: 0,
    submitted: 0,
    planning: 0,
    waiting_for_plan_approval: 0,
    creating_github_issue: 1,
    creating_branch: 1,
    running_ai: 2,
    improving: 2,
    needs_approval: 2,
    provider_failed: 2,
    budget_exceeded: 2,
    iteration_limit_reached: 2,
    repeated_error_detected: 2,
    approval_rejected: 2,
    validating: 3,
    validation_failed: 3,
    reviewing: 4,
    creating_pr: 5,
    ready_for_user_review: 5,
    completed: 5
  };
  const inferredStage = inferWorkflowStageFromLogs(logs);
  const currentStage = statusStage[task.status] ?? inferredStage;
  const failed = terminalStatuses.has(task.status) && task.status !== 'completed' && task.status !== 'cancelled';
  const activities = collectTaskActivityEntries(logs, task.id);

  return stages.map((stage, index) => {
    let state: WorkflowStepState = index < currentStage ? 'completed' : index === currentStage ? 'active' : 'pending';
    if (task.status === 'completed') state = 'completed';
    if (failed && index === currentStage) state = 'failed';
    if (task.status === 'cancelled' && index === currentStage) state = 'failed';
    const stageActivities = activities.filter((activity) => activityWorkflowStage(activity) === index);
    const latestStageActivity = [...stageActivities].reverse().find((activity) => (
      (activity.state === 'completed' || activity.state === 'failed') && activity.elapsedMs > 0
    )) ?? stageActivities.at(-1);
    const stageTiming = summarizeWorkflowStageTiming(activities, index);
    const activityDetail = latestStageActivity
      ? formatWorkflowStageDetail(latestStageActivity, stageTiming, index)
      : undefined;

    return {
      ...stage,
      state,
      detail: activityDetail ?? (index === currentStage ? statusLabels[task.status] : stage.detail)
    };
  });
}

function summarizeWorkflowStageTiming(
  activities: TaskActivityEntry[],
  stageIndex: number
): WorkflowStageTiming {
  const stageActivities = activities.filter((activity) => activityWorkflowStage(activity) === stageIndex);
  const completedActivities = stageActivities.filter((activity) => (
    activity.kind === 'activity'
    && (activity.state === 'completed' || activity.state === 'failed')
    && activity.elapsedMs > 0
  ));
  const recordedProviderAttempts = new Set(
    completedActivities
      .filter((activity) => activity.operation?.startsWith('provider_'))
      .map((activity) => `${activity.phase}:${activity.attempt}`)
  );
  const providerFallbacks = stageActivities.filter((activity) => (
    activity.kind === 'lifecycle'
    && (activity.state === 'completed' || activity.state === 'failed')
    && activity.elapsedMs > 0
    && !recordedProviderAttempts.has(`${activity.phase}:${activity.attempt}`)
  ));
  const attempts = new Set(
    [...completedActivities, ...providerFallbacks]
      .filter((activity) => activity.attempt > 0 || activity.phase === 'planning')
      .map((activity) => `${activity.phase}:${activity.attempt}`)
  );

  return {
    elapsedMs: [...completedActivities, ...providerFallbacks]
      .reduce((total, activity) => total + activity.elapsedMs, 0),
    attemptCount: attempts.size
  };
}

function formatWorkflowStageDetail(
  latestActivity: TaskActivityEntry,
  timing: WorkflowStageTiming,
  stageIndex: number
): string {
  if (timing.elapsedMs <= 0) {
    return latestActivity.title;
  }

  const attempts = stageIndex >= 2 && stageIndex <= 4 && timing.attemptCount > 1
    ? ` · ${timing.attemptCount} průchody`
    : '';
  return `${latestActivity.title} · celkem ${formatElapsedTime(timing.elapsedMs)}${attempts}`;
}

function activityWorkflowStage(activity: TaskActivityEntry): number {
  if (activity.phase === 'workspace' || activity.phase === 'planning') return 0;
  if (
    activity.phase === 'github'
    && (activity.operation === 'create_issue' || activity.operation === 'create_branch')
  ) return 1;
  if (activity.phase === 'implementation') return 2;
  if (activity.phase === 'validation') return 3;
  if (activity.phase === 'review') return 4;
  return 5;
}

function inferWorkflowStageFromLogs(logs: AuditEventApi[]): number {
  const eventStages: Array<[string, number]> = [
    ['task_status_creating_pr', 5],
    ['task_status_reviewing', 4],
    ['task_status_validating', 3],
    ['task_status_running_ai', 2],
    ['task_status_creating_branch', 1],
    ['task_status_creating_github_issue', 1]
  ];

  for (const event of [...logs].reverse()) {
    const match = eventStages.find(([eventType]) => event.eventType === eventType);
    if (match) return match[1];
  }

  return 0;
}

function formatQueueLabel(task: TaskSummary, queue?: TaskQueueApi): string {
  if (queue?.queuePosition) {
    return `${queue.queuePosition}/${queue.queueDepth}`;
  }

  if (task.status === 'submitted') {
    return `0/${queue?.queueDepth ?? 0}`;
  }

  return 'Mimo frontu';
}

function formatRunTitle(run: TaskRunApi): string {
  return `${run.provider}/${run.model} | ${run.status} | iterace ${run.iterationCount}`;
}

function resolveLatestTaskError(
  taskStatus: TaskSummary['status'],
  logs: AuditEventApi[],
  latestRun: TaskRunApi | undefined
): string | undefined {
  if (!errorStatuses.has(taskStatus)) {
    return undefined;
  }

  if (latestRun?.errorMessage?.trim()) {
    return latestRun.errorMessage.trim();
  }

  for (const event of [...logs].reverse()) {
    if (event.eventType !== 'task_failed' || !isRecord(event.payload)) {
      continue;
    }

    const errorMessage = event.payload.errorMessage;
    if (typeof errorMessage === 'string' && errorMessage.trim()) {
      return errorMessage.trim();
    }
  }

  return undefined;
}

function mapRealtimeUiState(state: RealtimeConnectionState): RealtimeUiState {
  if (state === 'connected') {
    return 'connected';
  }

  if (state === 'reconnecting' || state === 'connecting') {
    return 'reconnecting';
  }

  return 'fallback';
}

function formatRealtimeState(state: RealtimeUiState): string {
  if (state === 'connected') {
    return 'connected';
  }

  if (state === 'reconnecting') {
    return 'reconnecting';
  }

  return 'fallback polling';
}

function formatHeartbeatStatus(meta: RealtimeConnectionMeta): string {
  if (!meta.lastHeartbeatAt) {
    return meta.state === 'connected' ? 'waiting for first heartbeat' : 'no heartbeat';
  }

  const timestamp = Date.parse(meta.lastHeartbeatAt);
  if (Number.isNaN(timestamp)) {
    return 'invalid heartbeat';
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return `${formatProgressTime(meta.lastHeartbeatAt)} | ${ageSeconds}s ago`;
}

function formatTokenUsage(usage: TaskUsageApi | undefined): string {
  if (!usage || usage.usageSource === 'unavailable') {
    return 'Neni dostupne';
  }

  if (usage.usageSource === 'actual_breakdown') {
    return `${usage.totalTokens.toLocaleString('cs-CZ')} celkem · ${usage.inputTokens.toLocaleString('cs-CZ')} in · ${usage.outputTokens.toLocaleString('cs-CZ')} out · ${usage.cachedTokens.toLocaleString('cs-CZ')} cache`;
  }

  if (usage.usageSource === 'estimated') {
    return `${usage.totalTokens.toLocaleString('cs-CZ')} odhad`;
  }

  const suffix = usage.usageSource === 'mixed' ? ' · starsi behy jsou pouze odhad' : '';
  return `${usage.totalTokens.toLocaleString('cs-CZ')} celkem${suffix}`;
}

function formatRunDetail(run: TaskRunApi, maxLength = 260): string {
  return truncateText(run.errorMessage ?? run.summary ?? 'Bez detailu.', maxLength);
}

function formatAuditPayload(payload: unknown, maxLength = 260): string {
  if (payload === null || payload === undefined) {
    return '';
  }

  if (!isRecord(payload)) {
    return truncateText(String(payload), maxLength);
  }

  const keys = [
    'from',
    'to',
    'status',
    'phase',
    'attempt',
    'provider',
    'model',
    'branchName',
    'pullRequestUrl',
    'issueUrl',
    'reason',
    'retryReason',
    'errorMessage',
    'error'
  ];
  const parts = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(payload, key) && !isSensitiveKey(key))
    .map((key) => `${key}: ${formatPayloadValue(payload[key])}`)
    .filter((part) => part.trim().length > 0);

  if (parts.length > 0) {
    return truncateText(parts.join(' | '), maxLength);
  }

  return truncateText(safeJson(payload), maxLength);
}

function formatPayloadValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
      ? value.map(String).join(', ')
      : `${value.length} item(s)`;
  }

  if (isRecord(value)) {
    return safeJson(value);
  }

  return value === undefined || value === null ? '' : String(value);
}

function collectTaskActivityEntries(
  logs: AuditEventApi[],
  taskId: string
): TaskActivityEntry[] {
  return logs
    .filter((event) => event.taskId === taskId)
    .map(toTaskActivityEntry)
    .filter((entry): entry is TaskActivityEntry => Boolean(entry))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function appendAuditEvent(current: AuditEventApi[] | undefined, event: AuditEventApi): AuditEventApi[] {
  if (!current) {
    return [event];
  }
  if (current.some((item) => item.id === event.id)) {
    return current;
  }
  return [...current, event].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function toTaskActivityEntry(event: AuditEventApi): TaskActivityEntry | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }

  if (event.eventType === 'task_failed') {
    return {
      id: event.id,
      createdAt: event.createdAt,
      phase: 'completion',
      attempt: 0,
      state: 'failed',
      title: 'Task skončil chybou',
      detail: typeof event.payload.errorMessage === 'string' ? event.payload.errorMessage : undefined,
      kind: 'activity',
      elapsedMs: 0
    };
  }

  if (event.eventType === 'task_worker_interrupted') {
    return {
      id: event.id,
      createdAt: event.createdAt,
      phase: 'workspace',
      attempt: 0,
      state: 'progress',
      title: 'Worker byl restartován',
      detail: 'Task bude pokračovat ze zachovaného pracovního prostoru.',
      kind: 'activity',
      elapsedMs: 0
    };
  }

  if (event.eventType.startsWith('task_status_')) {
    const status = event.eventType.slice('task_status_'.length) as TaskSummary['status'];
    if (!Object.prototype.hasOwnProperty.call(statusLabels, status)) {
      return undefined;
    }
    const failedStatus = terminalStatuses.has(status) && status !== 'completed' && status !== 'cancelled';
    return {
      id: event.id,
      createdAt: event.createdAt,
      phase: statusActivityPhase(status),
      attempt: typeof event.payload.attempt === 'number' ? event.payload.attempt : 0,
      state: failedStatus ? 'failed' : status === 'completed' || status === 'ready_for_user_review' ? 'completed' : 'progress',
      title: statusLabels[status],
      detail: typeof event.payload.errorMessage === 'string'
        ? event.payload.errorMessage
        : typeof event.payload.retryReason === 'string'
          ? event.payload.retryReason
          : undefined,
      kind: 'activity',
      elapsedMs: 0
    };
  }

  if (event.eventType === 'task_activity') {
    const state = event.payload.state;
    const title = event.payload.title;
    if (
      (state !== 'started' && state !== 'progress' && state !== 'completed' && state !== 'failed')
      || typeof title !== 'string'
    ) {
      return undefined;
    }
    return {
      id: event.id,
      createdAt: event.createdAt,
      phase: typeof event.payload.phase === 'string' ? event.payload.phase : 'task',
      attempt: typeof event.payload.attempt === 'number' ? event.payload.attempt : 0,
      state,
      title,
      detail: typeof event.payload.detail === 'string' ? event.payload.detail : undefined,
      operation: typeof event.payload.operation === 'string' ? event.payload.operation : undefined,
      kind: 'activity',
      elapsedMs: typeof event.payload.elapsedMs === 'number' ? event.payload.elapsedMs : 0
    };
  }

  if (event.eventType !== 'task_provider_activity') {
    return undefined;
  }
  const kind = event.payload.kind;
  const message = event.payload.message;
  if (
    (kind !== 'lifecycle' && kind !== 'stdout' && kind !== 'stderr' && kind !== 'workspace')
    || typeof message !== 'string'
  ) {
    return undefined;
  }
  const summary = summarizeProviderActivity(kind, message);

  return {
    id: event.id,
    createdAt: event.createdAt,
    phase: typeof event.payload.phase === 'string' ? event.payload.phase : 'provider',
    attempt: typeof event.payload.attempt === 'number' ? event.payload.attempt : 0,
    state: summary.state,
    title: summary.title,
    detail: summary.detail,
    kind,
    elapsedMs: typeof event.payload.elapsedMs === 'number' ? event.payload.elapsedMs : 0
  };
}

function statusActivityPhase(status: TaskSummary['status']): string {
  if (status === 'creating_github_issue' || status === 'creating_branch') return 'github';
  if (status === 'validating' || status === 'validation_failed') return 'validation';
  if (status === 'reviewing') return 'review';
  if (status === 'creating_pr' || status === 'ready_for_user_review') return 'git';
  if (status === 'running_ai' || status === 'improving') return 'implementation';
  if (terminalStatuses.has(status)) return 'completion';
  return 'planning';
}

function summarizeProviderActivity(
  kind: Exclude<TaskActivityEntry['kind'], 'activity'>,
  message: string
): Pick<TaskActivityEntry, 'state' | 'title' | 'detail'> {
  const normalized = message.trim();
  if (kind === 'workspace') {
    return {
      state: 'progress',
      title: 'AI upravuje soubory',
      detail: normalized.replace(/^Workspace changed:\s*/i, '')
    };
  }
  if (kind === 'lifecycle') {
    if (/completed/i.test(normalized)) {
      return { state: 'completed', title: 'AI dokončila zpracování', detail: normalized };
    }
    if (/stopping|timeout/i.test(normalized)) {
      return { state: 'failed', title: 'AI zpracování se zastavuje', detail: normalized };
    }
    return {
      state: 'started',
      title: /^Prompt sent to\b/i.test(normalized) ? 'Zadání bylo odesláno AI' : 'AI proces byl spuštěn',
      detail: normalized
    };
  }
  if (/^exec\b/i.test(normalized)) {
    return { state: 'progress', title: 'AI spouští příkaz', detail: normalized };
  }
  if (/^succeeded in\b/i.test(normalized)) {
    return { state: 'progress', title: 'Podřízený příkaz byl dokončen', detail: normalized };
  }
  if (/tokens used/i.test(normalized)) {
    return { state: 'progress', title: 'AI dokončuje odpověď', detail: normalized };
  }
  return {
    state: 'progress',
    title: kind === 'stderr' ? 'AI pracuje v repozitáři' : 'AI posílá průběžný výstup',
    detail: normalized
  };
}

function formatElapsedTime(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return '0s';
  }

  const totalSeconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatDurationSeconds(totalSeconds: number): string {
  if (totalSeconds <= 1) {
    return 'právě teď';
  }
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

function formatPhase(phase: string): string {
  const labels: Record<string, string> = {
    workspace: 'Příprava',
    planning: 'Planning',
    implementation: 'Implementation',
    validation: 'Validation',
    review: 'Review',
    git: 'Git',
    github: 'GitHub',
    completion: 'Dokončení'
  };

  return labels[phase] ?? formatEventType(phase);
}

function formatEventType(eventType: string): string {
  return eventType
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatProgressTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? '-' : new Date(timestamp).toLocaleTimeString();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactSensitive(value));
  } catch {
    return String(value);
  }
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, isSensitiveKey(key) ? '[redacted]' : redactSensitive(entryValue)])
  );
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|credential|apiKey/i.test(key);
}

function MetricBlock(props: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={props.wide ? 'metric-block wide' : 'metric-block'}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function NewTaskForm({ projects, saving, onSubmit }: { projects: ProjectSummary[]; saving: boolean; onSubmit: (formData: FormData) => void }) {
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? '');
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const [mode, setMode] = useState<CreateTaskRequest['mode']>(selectedProject?.defaultTaskMode ?? 'safe');

  useEffect(() => {
    if (!projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? '');
    }
  }, [projects, selectedProjectId]);

  return (
    <form
      className="task-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
        event.currentTarget.reset();
      }}
    >
      <label>
        Projekt
        <select
          name="projectId"
          value={selectedProject?.id ?? ''}
          onChange={(event) => {
            const project = projects.find((candidate) => candidate.id === event.target.value);
            setSelectedProjectId(event.target.value);
            setMode(project?.defaultTaskMode ?? 'safe');
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Název tasku
        <input name="title" placeholder="Upravit galerii fotek" required minLength={3} />
      </label>
      <label className="wide">
        Komplexní zadání
        <textarea name="prompt" placeholder="Popiš cíl, kontext, omezení a akceptační kritéria." required minLength={10} rows={8} />
      </label>
      <label>
        Priorita
        <select name="priority" defaultValue="medium">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label>
        Režim
        <select name="mode" value={mode} onChange={(event) => setMode(event.target.value as CreateTaskRequest['mode'])}>
          <option value="safe">Safe</option>
          <option value="auto">Auto</option>
          <option value="full_auto">Full-auto</option>
        </select>
      </label>
      <label className="wide">
        Scope files (1 na řádek nebo oddělené čárkou)
        <textarea name="scopeFiles" rows={4} placeholder="src/App.tsx&#10;packages/core/src/model.ts" />
      </label>
      <label className="wide">
        Akceptační kritéria (1 na řádek)
        <textarea name="acceptanceCriteria" rows={4} placeholder="Build projde bez chyb&#10;Task je ve stavu ready_for_user_review" />
      </label>
      <label className="wide">
        Runtime summary (volitelné)
        <textarea name="runtimeSummary" rows={3} placeholder="Krátké provozní omezení, dependency kontext, očekávané guardrails." />
      </label>
      <label>
        Max. rozpočet
        <input name="maxBudgetUsd" type="number" min="0" step="0.5" defaultValue="2" />
      </label>
      <label>
        Max. iterací
        <input name="maxIterations" type="number" min="1" max="50" defaultValue="10" />
      </label>
      <button className="primary-action wide" type="submit" disabled={saving || projects.length === 0}>
        <Smartphone size={18} />
        Vytvořit task
      </button>
    </form>
  );
}

function ApprovalPanel(props: {
  approval: ApprovalSummary;
  tasks: TaskSummary[];
  resolving: boolean;
  onResolve: (id: string, status: 'approved' | 'rejected') => void;
}) {
  const task = props.tasks.find((item) => item.id === props.approval.taskId);
  return (
    <article className="approval-panel">
      <div className="approval-heading">
        <span className={`badge risk-${props.approval.riskLevel}`}>{props.approval.riskLevel}</span>
        <span className={`badge ${props.approval.status}`}>{props.approval.status}</span>
      </div>
      <h2>{props.approval.title}</h2>
      <p className="muted">{task?.title ?? props.approval.taskId}</p>
      <dl>
        <div>
          <dt>Důvod</dt>
          <dd>{props.approval.reason}</dd>
        </div>
        <div>
          <dt>Riziko</dt>
          <dd>{props.approval.risk}</dd>
        </div>
        <div>
          <dt>Doporučení</dt>
          <dd>{props.approval.recommendation}</dd>
        </div>
      </dl>
      <div className="file-strip">
        {props.approval.touchedFiles.map((file) => (
          <span key={file}>{file}</span>
        ))}
      </div>
      <div className="actions">
        <button
          className="primary-action"
          type="button"
          disabled={props.approval.status !== 'pending' || props.resolving}
          onClick={() => props.onResolve(props.approval.id, 'approved')}
        >
          <CheckCircle2 size={18} />
          Schválit
        </button>
        <button
          className="danger-action"
          type="button"
          disabled={props.approval.status !== 'pending' || props.resolving}
          onClick={() => props.onResolve(props.approval.id, 'rejected')}
        >
          <XCircle size={18} />
          Zamítnout
        </button>
      </div>
    </article>
  );
}

function ProjectsPanel(props: {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  selectedProjectId?: string;
  onSelectProject: (projectId: string) => void;
  providerStatus?: ProviderStatusApi;
  roadmap?: ProjectRoadmapApi;
  roadmapLoading: boolean;
  roadmapError?: string;
  saving: boolean;
  updatingProject: boolean;
  updateProjectError?: string;
  projectUpdated: boolean;
  updatingAutomation: boolean;
  automationUpdateError?: string;
  automationUpdated: boolean;
  assigningRepository: boolean;
  generatingRoadmap: boolean;
  decidingExtension: boolean;
  deletingProject: boolean;
  deleteProjectError?: string;
  onCreateProject: (formData: FormData) => void;
  onAssignProjectRepository: (projectId: string, formData: FormData) => void;
  onUpdateProjectBrief: (projectId: string, formData: FormData) => void;
  onUpdateProjectAutomation: (projectId: string, input: UpdateProjectRequest) => void;
  onGenerateRoadmap: (projectId: string, input?: GenerateProjectRoadmapRequest) => void;
  onDecideExtension: (projectId: string, input: DecideProjectRoadmapExtensionRequest) => void;
  onDeleteProject: (projectId: string, input: DeleteProjectRequest) => void;
  githubRepositories: GitHubRepositoryApi[];
  githubRepositoriesLoading: boolean;
  githubRepositoriesError?: string;
  githubRepositoryOwners: GitHubRepositoryOwnerApi[];
  githubRepositoryOwnersLoading: boolean;
  githubRepositoryOwnersError?: string;
}) {
  const selectedProject = props.projects.find((project) => project.id === props.selectedProjectId) ?? props.projects[0];
  const [briefDraft, setBriefDraft] = useState(selectedProject?.brief ?? '');
  const [autoCreatePullRequest, setAutoCreatePullRequest] = useState(selectedProject?.autoCreatePullRequest ?? true);
  const [autoMergePullRequest, setAutoMergePullRequest] = useState(selectedProject?.autoMergePullRequest ?? false);
  const [autoCompleteTask, setAutoCompleteTask] = useState(selectedProject?.autoCompleteTask ?? false);
  const [allowSafeOperationsWithoutApproval, setAllowSafeOperationsWithoutApproval] = useState(
    selectedProject?.allowSafeOperationsWithoutApproval ?? false
  );
  const [defaultTaskMode, setDefaultTaskMode] = useState<CreateTaskRequest['mode']>(selectedProject?.defaultTaskMode ?? 'safe');
  const [aiProviderConnectionId, setAiProviderConnectionId] = useState(selectedProject?.aiProviderConnectionId ?? '');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteGitHubRepository, setDeleteGitHubRepository] = useState(false);
  const latestCycle = props.roadmap?.cycles.at(-1);
  const cycleSteps = latestCycle ? props.roadmap?.steps.filter((step) => step.cycleId === latestCycle.id) ?? [] : [];
  const roadmapUsesOlderBrief = Boolean(
    latestCycle?.cycleNumber === 1
    && selectedProject?.brief?.trim()
    && latestCycle.objective.trim() !== selectedProject.brief.trim()
  );

  useEffect(() => {
    setBriefDraft(selectedProject?.brief ?? '');
  }, [selectedProject?.brief, selectedProject?.id]);

  useEffect(() => {
    setAutoCreatePullRequest(selectedProject?.autoCreatePullRequest ?? true);
    setAutoMergePullRequest(selectedProject?.autoMergePullRequest ?? false);
    setAutoCompleteTask(selectedProject?.autoCompleteTask ?? false);
    setAllowSafeOperationsWithoutApproval(selectedProject?.allowSafeOperationsWithoutApproval ?? false);
    setDefaultTaskMode(selectedProject?.defaultTaskMode ?? 'safe');
    setAiProviderConnectionId(selectedProject?.aiProviderConnectionId ?? '');
  }, [
    selectedProject?.id,
    selectedProject?.autoCreatePullRequest,
    selectedProject?.autoMergePullRequest,
    selectedProject?.autoCompleteTask,
    selectedProject?.allowSafeOperationsWithoutApproval,
    selectedProject?.defaultTaskMode,
    selectedProject?.aiProviderConnectionId
  ]);

  useEffect(() => {
    setDeleteConfirmation('');
    setDeleteGitHubRepository(false);
  }, [selectedProject?.id]);

  return (
    <section className="workspace">
      <div className="task-list">
        <MetricRow label="Projekty" value={String(props.projects.length)} />
        <MetricRow label="Aktivni tasky" value={String(props.tasks.filter((task) => !terminalStatuses.has(task.status)).length)} />
        <form
          className="task-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onCreateProject(new FormData(event.currentTarget));
            event.currentTarget.reset();
          }}
        >
          <label>
            Nazev projektu
            <input name="name" placeholder="ForgeMind Studio" required minLength={2} />
          </label>
          <label>
            Slug
            <input name="slug" placeholder="forgemind-studio" required pattern="[a-z0-9-]+" />
          </label>
          <label className="wide">
            Komplexni zadani projektu
            <textarea name="brief" rows={7} minLength={20} placeholder="Popis celeho produktu, cilu a omezeni." />
          </label>
          <label className="wide">
            agent.config.yaml
            <textarea name="configYaml" rows={4} placeholder="Volitelne YAML nastaveni projektu." />
          </label>
          <input type="hidden" name="repositoryMode" value="existing" />
          <input type="hidden" name="branchMode" value="existing" />
          <input type="hidden" name="defaultBranch" value="main" />
          <button className="primary-action wide" type="submit" disabled={props.saving}>
            <FolderPlus size={18} />
            Pridat projekt
          </button>
        </form>
        {props.projects.map((project) => (
          <button
            key={project.id}
            className={project.id === selectedProject?.id ? 'task-row project-selector-row selected' : 'task-row project-selector-row'}
            type="button"
            onClick={() => props.onSelectProject(project.id)}
          >
            <span>
              <strong>{project.name}</strong>
              <small>{project.githubOwner && project.githubRepo ? `${project.githubOwner}/${project.githubRepo}` : 'Repo neprirazeno'}</small>
            </span>
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
      {selectedProject ? (
        <article className="detail">
          <label className="mobile-project-switch">
            Projekt
            <select value={selectedProject.id} onChange={(event) => props.onSelectProject(event.target.value)}>
              {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <div className="detail-heading">
            <div>
              <h2>{selectedProject.name}</h2>
              <p>{selectedProject.githubOwner && selectedProject.githubRepo ? `${selectedProject.githubOwner}/${selectedProject.githubRepo}` : 'Repo neprirazeno'}</p>
            </div>
            <div className="branch">
              <GitBranch size={18} />
              <span>{selectedProject.defaultBranch}</span>
            </div>
          </div>
          <div className="detail-grid">
            <MetricBlock label="Open PR" value={String(selectedProject.openPullRequests)} />
            <MetricBlock label="Cykly" value={String(props.roadmap?.cycles.length ?? 0)} />
            <MetricBlock label="Kroky" value={String(cycleSteps.length)} />
          </div>
          <section className="plain-section">
            <h3>Projektove zadani</h3>
            <form
              className="task-form"
              onSubmit={(event) => {
                event.preventDefault();
                props.onUpdateProjectBrief(selectedProject.id, new FormData(event.currentTarget));
              }}
            >
              <label className="wide">
                Komplexni zadani projektu
                <textarea
                  name="brief"
                  rows={10}
                  value={briefDraft}
                  minLength={20}
                  onChange={(event) => setBriefDraft(event.target.value)}
                  placeholder="Sem patri plne zadani projektu. Prazdne pole zadani odstrani."
                />
              </label>
              {props.updateProjectError ? <div className="error-banner wide">{props.updateProjectError}</div> : null}
              {props.projectUpdated && briefDraft === (selectedProject.brief ?? '') ? (
                <div className="success-banner wide">Zadani bylo ulozeno.</div>
              ) : null}
              {roadmapUsesOlderBrief ? (
                <div className="warning-banner wide">
                  Aktualni roadmapa vznikla ze starsiho zadani. Pred pokracovanim ji pregeneruj.
                </div>
              ) : null}
              <div className="actions wide">
                <button className="secondary-action" type="submit" disabled={props.updatingProject}>
                  Ulozit zadani
                </button>
                <button
                  className="primary-action"
                  type="button"
                  disabled={props.generatingRoadmap || !selectedProject.brief?.trim()}
                  onClick={() => props.onGenerateRoadmap(selectedProject.id)}
                >
                  {props.roadmap?.cycles.length ? 'Pregenerovat implementacni kroky' : 'Vytvorit implementacni kroky'}
                </button>
              </div>
            </form>
          </section>
          <section className="plain-section">
            <h3>GitHub repository</h3>
            <ProjectRepositoryAssignmentForm
              project={selectedProject}
              repositories={props.githubRepositories}
              repositoryOwners={props.githubRepositoryOwners}
              loading={props.githubRepositoriesLoading}
              error={props.githubRepositoriesError}
              ownersLoading={props.githubRepositoryOwnersLoading}
              ownersError={props.githubRepositoryOwnersError}
              assigningRepository={props.assigningRepository}
              onAssignProjectRepository={props.onAssignProjectRepository}
            />
          </section>
          <section className="plain-section">
            <h3>Automatizace tasku</h3>
            <form
              className="task-form automation-form"
              onSubmit={(event) => {
                event.preventDefault();
                props.onUpdateProjectAutomation(selectedProject.id, {
                  autoCreatePullRequest,
                  autoMergePullRequest,
                  autoCompleteTask,
                  allowSafeOperationsWithoutApproval,
                  defaultTaskMode,
                  aiProviderConnectionId: aiProviderConnectionId || null
                });
              }}
            >
              <label className="wide">
                Primarni AI provider connection
                <select value={aiProviderConnectionId} onChange={(event) => setAiProviderConnectionId(event.target.value)}>
                  <option value="">Vychozi podle projektu / env</option>
                  {props.providerStatus?.connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} ({connection.provider}/{connection.model}){connection.isDefault ? ' - default' : ''}
                    </option>
                  ))}
                </select>
                <small>Uložený provider connection, který se použije jako primární pro tento projekt.</small>
              </label>
              <label className="wide">
                Vychozi rezim tasku
                <select value={defaultTaskMode} onChange={(event) => setDefaultTaskMode(event.target.value as CreateTaskRequest['mode'])}>
                  <option value="safe">Safe</option>
                  <option value="auto">Auto</option>
                  <option value="full_auto">Full-auto</option>
                </select>
                <small>Pouzije se pro roadmap tasky a jako vychozi volba u rucne vytvorenych tasku.</small>
              </label>
              <label className="toggle-row wide">
                <input
                  type="checkbox"
                  checked={autoCreatePullRequest}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setAutoCreatePullRequest(checked);
                    if (!checked) {
                      setAutoMergePullRequest(false);
                      setAutoCompleteTask(false);
                    }
                  }}
                />
                <span>
                  <strong>Automaticky vytvorit pull request</strong>
                  <small>Bez automatickeho merge zustane pull request jako draft.</small>
                </span>
              </label>
              <label className="toggle-row wide">
                <input
                  type="checkbox"
                  checked={autoMergePullRequest}
                  disabled={!autoCreatePullRequest}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setAutoMergePullRequest(checked);
                    if (!checked) setAutoCompleteTask(false);
                  }}
                />
                <span>
                  <strong>Automaticky mergnout do {selectedProject.defaultBranch}</strong>
                  <small>Po uspesne validaci a review vytvori bezny PR a provede squash merge.</small>
                </span>
              </label>
              <label className="toggle-row wide">
                <input
                  type="checkbox"
                  checked={autoCompleteTask}
                  disabled={!autoMergePullRequest}
                  onChange={(event) => setAutoCompleteTask(event.target.checked)}
                />
                <span>
                  <strong>Po potvrzenem merge dokoncit task</strong>
                  <small>Task se oznaci jako completed pouze kdyz GitHub potvrdi merge.</small>
                </span>
              </label>
              <label className="toggle-row wide">
                <input
                  type="checkbox"
                  checked={allowSafeOperationsWithoutApproval}
                  onChange={(event) => setAllowSafeOperationsWithoutApproval(event.target.checked)}
                />
                <span>
                  <strong>Bez schvaleni bezpecnych operaci</strong>
                  <small>Rizikove operace, merge, mazani, migrace a systemove zmeny zustavaji chranene.</small>
                </span>
              </label>
              {props.automationUpdateError ? <div className="error-banner wide">{props.automationUpdateError}</div> : null}
              {props.automationUpdated
                && autoCreatePullRequest === selectedProject.autoCreatePullRequest
                && autoMergePullRequest === selectedProject.autoMergePullRequest
                && autoCompleteTask === selectedProject.autoCompleteTask
                && allowSafeOperationsWithoutApproval === selectedProject.allowSafeOperationsWithoutApproval
                && defaultTaskMode === selectedProject.defaultTaskMode ? (
                <div className="success-banner wide">Automatizace byla ulozena.</div>
              ) : null}
              <div className="actions wide">
                <button className="secondary-action" type="submit" disabled={props.updatingAutomation}>
                  Ulozit automatizaci
                </button>
              </div>
            </form>
          </section>
          <section className="plain-section">
            <h3>Roadmap</h3>
            {props.roadmapLoading ? <p>Nacitam roadmapu...</p> : null}
            {props.roadmapError ? <div className="error-banner">{props.roadmapError}</div> : null}
            {!props.roadmapLoading && !latestCycle ? <p>Zatim bez roadmap cyklu.</p> : null}
            {latestCycle ? (
              <>
                <div className="project-row">
                  <div>
                    <strong>Cyklus {latestCycle.cycleNumber}</strong>
                    <p>{latestCycle.objective}</p>
                  </div>
                  <MetricBlock label="Status" value={latestCycle.status} />
                </div>
                <div className="timeline">
                  {cycleSteps.map((step) => {
                    const task = step.taskId ? props.tasks.find((item) => item.id === step.taskId) : undefined;
                    return (
                      <div className="timeline-row" key={step.id}>
                        <span>{step.sequenceNumber}.</span>
                        <strong>{step.title}</strong>
                        <small>{step.status}{task ? ` | ${task.title}` : ''}</small>
                      </div>
                    );
                  })}
                </div>
                {latestCycle.extensionProposal ? (
                  <div className="prompt-response-panel">
                    <div className="prompt-response-header">
                      <strong>Dalsi navrzene rozsireni</strong>
                      <span>{latestCycle.status}</span>
                    </div>
                    <div className="prompt-response-body">
                      <div className="prompt-response-block">
                        <pre>{latestCycle.extensionProposal}</pre>
                      </div>
                    </div>
                    <div className="actions">
                      <button
                        className="primary-action"
                        type="button"
                        disabled={props.decidingExtension}
                        onClick={() => props.onDecideExtension(selectedProject.id, { approved: true })}
                      >
                        Schvalit
                      </button>
                      <button
                        className="secondary-action"
                        type="button"
                        disabled={props.decidingExtension}
                        onClick={() => props.onDecideExtension(selectedProject.id, { approved: false })}
                      >
                        Zamitnout
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
          <section className="plain-section danger-zone">
            <div className="section-heading">
              <div>
                <h3>Nebezpecna zona</h3>
                <p>Smazani projektu je trvale a odstrani jeho tasky, behy, roadmapu i auditni zaznamy.</p>
              </div>
            </div>
            <form
              className="task-form"
              onSubmit={(event) => {
                event.preventDefault();
                props.onDeleteProject(selectedProject.id, {
                  confirmation: deleteConfirmation,
                  deleteGitHubRepository
                });
              }}
            >
              {selectedProject.githubOwner && selectedProject.githubRepo ? (
                <label className="toggle-row wide destructive-toggle">
                  <input
                    type="checkbox"
                    checked={deleteGitHubRepository}
                    onChange={(event) => setDeleteGitHubRepository(event.target.checked)}
                  />
                  <span>
                    <strong>Smazat take GitHub repozitar {selectedProject.githubOwner}/{selectedProject.githubRepo}</strong>
                    <small>Repozitar, jeho branche, issues a pull requesty budou na GitHubu nenavratne odstraneny.</small>
                  </span>
                </label>
              ) : null}
              <label className="wide">
                Pro potvrzeni napiste presny nazev projektu: <strong>{selectedProject.name}</strong>
                <input
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {props.deleteProjectError ? <div className="error-banner wide">{props.deleteProjectError}</div> : null}
              <div className="actions wide">
                <button
                  className="danger-action"
                  type="submit"
                  disabled={props.deletingProject || deleteConfirmation !== selectedProject.name}
                >
                  <Trash2 size={18} />
                  {deleteGitHubRepository ? 'Smazat projekt i repozitar' : 'Smazat projekt'}
                </button>
              </div>
            </form>
          </section>
        </article>
      ) : (
        <div className="empty-state">Zatim bez projektu.</div>
      )}
    </section>
  );
}

function SettingsPanel({
  githubAdapterStatus,
  githubAdapterLoading,
  githubAdapterBusy,
  githubAdapterMessage,
  githubAdapterError,
  onGitHubAdapterConnect,
  onGitHubAdapterDisconnect,
  providerStatus,
  providerLoading,
  providerBusy,
  providerError,
  onProviderConnect,
  onProviderDelete,
  onCodexOAuthStart,
  onCodexOAuthComplete,
  notificationSettings,
  notificationsLoading,
  notificationsBusy,
  notificationsError,
  onSubscribeNotifications,
  onUnsubscribeNotifications,
  onUpdateNotificationSettings
}: {
  githubAdapterStatus?: GitHubAdapterStatusApi;
  githubAdapterLoading: boolean;
  githubAdapterBusy: boolean;
  githubAdapterMessage?: string;
  githubAdapterError?: string;
  onGitHubAdapterConnect: (input: GitHubAdapterConnectRequest) => void;
  onGitHubAdapterDisconnect: () => void;
  providerStatus?: ProviderStatusApi;
  providerLoading: boolean;
  providerBusy: boolean;
  providerError?: string;
  onProviderConnect: (input: ProviderConnectRequest) => void;
  onProviderDelete: (connectionId: string) => void;
  onCodexOAuthStart: () => Promise<CodexOAuthStartResponse>;
  onCodexOAuthComplete: (loginId: string, model: string) => Promise<unknown>;
  notificationSettings?: NotificationSettingsApi;
  notificationsLoading: boolean;
  notificationsBusy: boolean;
  notificationsError?: string;
  onSubscribeNotifications: () => void;
  onUnsubscribeNotifications: () => void;
  onUpdateNotificationSettings: (input: Partial<NotificationSettingsApi['settings']>) => void;
}) {
  const [providerForm, setProviderForm] = useState<ProviderConnectRequest>({
    connectionId: undefined,
    name: '',
    provider: 'openai',
    authMode: 'api_key',
    apiKey: '',
    model: 'gpt-4o-mini',
    isDefault: false
  });
  const [codexOAuthLogin, setCodexOAuthLogin] = useState<CodexOAuthStartResponse | undefined>();
  const [githubAdapterForm, setGitHubAdapterForm] = useState<GitHubAdapterConnectRequest>({
    token: '',
    apiBaseUrl: ''
  });
  const providerConnections = providerStatus?.connections ?? [];

  useEffect(() => {
    if (!providerForm.connectionId) {
      return;
    }

    if (!providerConnections.some((connection) => connection.id === providerForm.connectionId)) {
      setProviderForm({
        connectionId: undefined,
        name: '',
        provider: 'openai',
        authMode: 'api_key',
        apiKey: '',
        model: 'gpt-4o-mini',
        isDefault: false
      });
    }
  }, [providerConnections, providerForm.connectionId]);

  function resetProviderForm() {
    setProviderForm({
      connectionId: undefined,
      name: '',
      provider: 'openai',
      authMode: 'api_key',
      apiKey: '',
      model: 'gpt-4o-mini',
      isDefault: false
    });
    setCodexOAuthLogin(undefined);
  }

  function editProviderConnection(connection: ProviderConnectionApi) {
    setProviderForm({
      connectionId: connection.id,
      name: connection.name,
      provider: connection.provider,
      authMode: connection.authMode,
      apiKey: '',
      model: connection.model,
      isDefault: connection.isDefault
    });
    setCodexOAuthLogin(undefined);
  }

  return (
    <section className="settings-grid">
      <article className="project-row">
        <div>
          <h2>GitHub adapter</h2>
          <p>Worker adapter pro vytvareni issue, branchi a draft PR.</p>
        </div>
        {githubAdapterLoading ? <p>Nacitam GitHub adapter status...</p> : null}
        {githubAdapterStatus ? (
          <>
            <MetricBlock label="Adapter" value={githubAdapterStatus.adapter === 'app' ? 'Pripojeno' : 'Odpojeno'} />
            <MetricBlock label="Configured" value={githubAdapterStatus.configured ? 'Ano' : 'Ne'} />
            <MetricBlock label="Credential" value={githubAdapterStatus.credentialSource} />
            <MetricBlock label="API" value={githubAdapterStatus.apiBaseUrl} wide />
            <MetricBlock label="Persistent" value={githubAdapterStatus.persistent ? 'Ano' : 'Ne'} />
          </>
        ) : null}
        {githubAdapterStatus?.missing.length ? <p>Chybi: {githubAdapterStatus.missing.join(', ')}</p> : null}
        {githubAdapterMessage ? <div className="success-banner">{githubAdapterMessage}</div> : null}
        {githubAdapterError ? <div className="error-banner">{githubAdapterError}</div> : null}
        <label className="wide">
          GitHub token
          <input
            type="password"
            placeholder="github_pat_... nebo installation token"
            value={githubAdapterForm.token}
            onChange={(event) => setGitHubAdapterForm((previous) => ({ ...previous, token: event.target.value }))}
          />
        </label>
        <label className="wide">
          GitHub API base URL
          <input
            placeholder="https://api.github.com"
            value={githubAdapterForm.apiBaseUrl ?? ''}
            onChange={(event) => setGitHubAdapterForm((previous) => ({ ...previous, apiBaseUrl: event.target.value }))}
          />
        </label>
        <div className="actions">
          <button
            className="primary-action"
            type="button"
            disabled={githubAdapterBusy || !githubAdapterForm.token.trim()}
            onClick={() =>
              onGitHubAdapterConnect({
                token: githubAdapterForm.token.trim(),
                apiBaseUrl: githubAdapterForm.apiBaseUrl?.trim() || undefined
              })
            }
          >
            Pripojit adapter
          </button>
          <button className="secondary-action" type="button" disabled={githubAdapterBusy} onClick={onGitHubAdapterDisconnect}>
            Odpojit GitHub
          </button>
        </div>
      </article>

      <article className="project-row">
        <div>
          <h2>AI provider pripojeni</h2>
          <p>Sprava pripojeni, zmena vychoziho provideru a mazani starych connectionu.</p>
        </div>
        {providerLoading ? <p>Nacitam provider status...</p> : null}
        {providerStatus ? (
          <>
            <MetricBlock label="Provider" value={providerStatus.currentProvider ?? 'Nenastaveno'} />
            <MetricBlock label="Model" value={providerStatus.currentModel ?? 'Nenastaveno'} />
            <MetricBlock label="Auth" value={providerStatus.authMode ?? providerStatus.credentialSource} />
            <MetricBlock label="Persistent" value={providerStatus.persistent ? 'Ano' : 'Ne'} />
          </>
        ) : null}
        {providerError ? <div className="error-banner">{providerError}</div> : null}
        <div className="provider-connection-list wide">
          {providerConnections.length ? (
            providerConnections.map((connection) => (
              <article
                key={connection.id}
                className={connection.id === providerForm.connectionId ? 'provider-connection-card selected' : 'provider-connection-card'}
              >
                <div className="provider-connection-summary">
                  <strong>{connection.name}</strong>
                  <small>
                    {connection.provider} · {connection.model}
                  </small>
                  <small>
                    {connection.authMode}
                    {connection.isDefault ? ' · default' : ''}
                    {connection.credentialSource ? ` · ${connection.credentialSource}` : ''}
                  </small>
                </div>
                <div className="actions">
                  <button className="secondary-action" type="button" onClick={() => editProviderConnection(connection)}>
                    Upravit
                  </button>
                  <button className="danger-action" type="button" onClick={() => onProviderDelete(connection.id)} disabled={providerBusy}>
                    Smazat
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="empty-state wide">Zatim neni pridany zadny provider connection.</p>
          )}
        </div>
        <div className="actions wide">
          <button className="secondary-action" type="button" onClick={resetProviderForm}>
            Novy connection
          </button>
        </div>
        <label>
          Provider
          <select
            value={providerForm.provider}
            onChange={(event) => {
              const provider = event.target.value as ProviderConnectRequest['provider'];
              setProviderForm((previous) => ({
                ...previous,
                provider,
                authMode: provider === 'codex' ? previous.authMode ?? 'api_key' : 'api_key',
                model:
                  provider === 'codex' && previous.model === 'gpt-4o-mini'
                    ? 'gpt-5.5'
                    : provider === 'github_copilot' && previous.model === 'gpt-4o-mini'
                      ? 'gpt-5.4'
                      : previous.model
              }));
              if (provider !== 'codex') {
                setCodexOAuthLogin(undefined);
              }
            }}
          >
            <option value="openai">openai</option>
            <option value="codex">codex</option>
            <option value="github_copilot">github_copilot</option>
          </select>
        </label>
        {providerForm.provider === 'codex' ? (
          <label>
            Auth
            <select
              value={providerForm.authMode ?? 'api_key'}
              onChange={(event) => {
                const authMode = event.target.value as NonNullable<ProviderConnectRequest['authMode']>;
                setProviderForm((previous) => ({ ...previous, authMode }));
                if (authMode !== 'codex_oauth') {
                  setCodexOAuthLogin(undefined);
                }
              }}
            >
              <option value="api_key">API key</option>
              <option value="codex_oauth">OAuth</option>
            </select>
          </label>
        ) : null}
        <label>
          Nazev connectionu
          <input
            placeholder="Personal OpenAI / Copilot / Codex"
            value={providerForm.name ?? ''}
            onChange={(event) => setProviderForm((previous) => ({ ...previous, name: event.target.value }))}
          />
        </label>
        {providerForm.authMode !== 'codex_oauth' ? (
          <label>
            {providerForm.provider === 'github_copilot' ? 'GitHub token (optional)' : 'API key'}
            <input
              type="password"
              placeholder={providerForm.provider === 'github_copilot' ? 'gho_... nebo github_pat_...' : 'paste provider api key'}
              value={providerForm.apiKey ?? ''}
              onChange={(event) => setProviderForm((previous) => ({ ...previous, apiKey: event.target.value }))}
            />
          </label>
        ) : null}
        <label>
          Model
          <input
            placeholder={
              providerForm.provider === 'codex'
                ? 'gpt-5.5'
                : providerForm.provider === 'github_copilot'
                  ? 'gpt-5.4'
                  : 'gpt-4o-mini'
            }
            value={providerForm.model}
            onChange={(event) => setProviderForm((previous) => ({ ...previous, model: event.target.value }))}
          />
        </label>
        <label className="toggle-row wide">
          <input
            type="checkbox"
            checked={Boolean(providerForm.isDefault)}
            onChange={(event) => setProviderForm((previous) => ({ ...previous, isDefault: event.target.checked }))}
          />
          <span>
            <strong>Nastavit jako default</strong>
            <small>Tento connection se pouzije jako vychozi provider pro projekty bez vlastni volby.</small>
          </span>
        </label>
        {codexOAuthLogin ? (
          <div className="oauth-panel wide">
            <span>Codex browser OAuth</span>
            <strong>Login spusten</strong>
            {codexOAuthLogin.loginUrl ? (
              <a href={codexOAuthLogin.loginUrl} target="_blank" rel="noreferrer">
                {codexOAuthLogin.loginUrl}
              </a>
            ) : null}
            <small>{codexOAuthLogin.codexHome}</small>
          </div>
        ) : null}
        <div className="actions">
          {providerForm.authMode === 'codex_oauth' ? (
            <>
              <button
                className="primary-action"
                type="button"
                disabled={providerBusy || !providerForm.model.trim()}
                onClick={async () => setCodexOAuthLogin(await onCodexOAuthStart())}
              >
                Otevrit browser OAuth
              </button>
              <button
                className="secondary-action"
                type="button"
                disabled={providerBusy || !codexOAuthLogin || !providerForm.model.trim()}
                onClick={async () => {
                  if (!codexOAuthLogin) return;
                  await onCodexOAuthComplete(codexOAuthLogin.loginId, providerForm.model.trim());
                }}
              >
                Dokoncit OAuth
              </button>
              <button
                className="secondary-action"
                type="button"
                disabled={providerBusy || !providerForm.model.trim()}
                onClick={() =>
                  onProviderConnect({
                    provider: 'codex',
                    authMode: 'codex_oauth',
                    model: providerForm.model.trim()
                  })
                }
              >
                Pouzit existujici OAuth
              </button>
            </>
          ) : null}
          <button
            className="primary-action"
            type="button"
            hidden={providerForm.authMode === 'codex_oauth'}
            disabled={providerBusy || !providerForm.model.trim()}
            onClick={() =>
              onProviderConnect({
                connectionId: providerForm.connectionId,
                name: providerForm.name?.trim() || undefined,
                isDefault: providerForm.isDefault,
                provider: providerForm.provider,
                authMode: 'api_key',
                apiKey: providerForm.apiKey?.trim() || undefined,
                model: providerForm.model.trim()
              })
            }
          >
            {providerForm.connectionId ? 'Ulozit zmeny' : 'Pripojit provider'}
          </button>
          {providerForm.connectionId ? (
            <button className="secondary-action" type="button" disabled={providerBusy} onClick={resetProviderForm}>
              Zrusit editaci
            </button>
          ) : null}
        </div>
      </article>

      <article className="project-row">
        <div>
          <h2>Push notifikace</h2>
          <p>Subscription lifecycle: subscribe, preference update, unsubscribe.</p>
        </div>
        {notificationsLoading ? <p>Nacitam nastaveni notifikaci...</p> : null}
        {!notificationsLoading && !notificationSettings ? <p>Notifikace nejsou dostupne.</p> : null}
        {notificationsError ? <div className="error-banner">{notificationsError}</div> : null}
        {notificationSettings ? (
          <>
            <MetricBlock label="Aktivni subscription" value={String(notificationSettings.subscriptions.length)} />
            <MetricBlock label="Push enabled" value={notificationSettings.settings.pushEnabled ? 'Ano' : 'Ne'} />
            {!notificationSettings.settings.pushEnabled ? (
              <p>Push notifikace jsou vypnuté. Pro zapnutí je potřeba dostupný VAPID public key na API serveru.</p>
            ) : null}
            <div className="actions">
              <button className="primary-action" type="button" onClick={onSubscribeNotifications} disabled={notificationsBusy}>
                Zapnout push
              </button>
              <button
                className="secondary-action"
                type="button"
                onClick={onUnsubscribeNotifications}
                disabled={notificationsBusy || notificationSettings.subscriptions.length === 0}
              >
                Vypnout push
              </button>
            </div>
            <div className="actions">
              <button
                className="secondary-action"
                type="button"
                onClick={() =>
                  onUpdateNotificationSettings({
                    approvalRequests: !notificationSettings.settings.approvalRequests
                  })
                }
                disabled={notificationsBusy}
              >
                Approval alerts: {notificationSettings.settings.approvalRequests ? 'ON' : 'OFF'}
              </button>
              <button
                className="secondary-action"
                type="button"
                onClick={() =>
                  onUpdateNotificationSettings({
                    taskUpdates: !notificationSettings.settings.taskUpdates
                  })
                }
                disabled={notificationsBusy}
              >
                Task updates: {notificationSettings.settings.taskUpdates ? 'ON' : 'OFF'}
              </button>
            </div>
          </>
        ) : null}
      </article>
    </section>
  );
}
