import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  GitBranch,
  Github,
  LayoutList,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smartphone,
  XCircle
} from 'lucide-react';
import {
  createTask as createTaskRequest,
  fallbackApprovals,
  fallbackProjects,
  fallbackTasks,
  fetchApprovals,
  fetchProjects,
  fetchTasks,
  resolveApproval as resolveApprovalRequest,
  startTask as startTaskRequest
} from './api.js';
import type { ApprovalSummary, CreateTaskRequest, ProjectSummary, TaskSummary } from './types.js';

type View = 'tasks' | 'new-task' | 'approvals' | 'settings';

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

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    retry: 1
  });
  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5000,
    retry: 1
  });
  const approvalsQuery = useQuery({
    queryKey: ['approvals'],
    queryFn: fetchApprovals,
    refetchInterval: 5000,
    retry: 1
  });

  const projects = projectsQuery.data ?? fallbackProjects;
  const tasks = tasksQuery.data ?? fallbackTasks;
  const approvals = approvalsQuery.data ?? fallbackApprovals;

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [selectedTaskId, tasks]);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0], [selectedTaskId, tasks]);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const activeTasks = tasks.filter((task) => task.status !== 'completed');
  const hasApiError = Boolean(projectsQuery.error || tasksQuery.error || approvalsQuery.error);

  const createTaskMutation = useMutation({
    mutationFn: createTaskRequest,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setSelectedTaskId(task.id);
      setView('tasks');
    }
  });

  const startTaskMutation = useMutation({
    mutationFn: startTaskRequest,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setSelectedTaskId(task.id);
    }
  });

  const resolveApprovalMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'rejected' }) => resolveApprovalRequest(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    }
  });

  function createTask(formData: FormData) {
    const input: CreateTaskRequest = {
      projectId: String(formData.get('projectId')),
      title: String(formData.get('title')),
      prompt: String(formData.get('prompt')),
      mode: String(formData.get('mode')) as CreateTaskRequest['mode'],
      maxBudgetUsd: Number(formData.get('maxBudgetUsd') || 2),
      maxIterations: Number(formData.get('maxIterations') || 10)
    };
    createTaskMutation.mutate(input);
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
        <NavButton
          active={view === 'approvals'}
          icon={ShieldCheck}
          label={`Approvals ${pendingApprovals.length}`}
          onClick={() => setView('approvals')}
        />
        <NavButton active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p>{projects.length} projekty</p>
            <h1>{viewTitle(view)}</h1>
          </div>
          <button className="primary-action" type="button" onClick={() => setView('new-task')}>
            <Plus size={18} />
            Nový task
          </button>
        </header>

        {hasApiError ? <div className="error-banner">API není dostupné, zobrazuji lokální fallback.</div> : null}

        {view === 'tasks' ? (
          <section className="workspace">
            <div className="task-list" aria-label="Seznam tasků">
              <MetricRow label="Aktivní tasky" value={String(activeTasks.length)} />
              <MetricRow label="Čekající approvals" value={String(pendingApprovals.length)} tone={pendingApprovals.length ? 'warning' : 'ok'} />
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
                onStart={(taskId) => startTaskMutation.mutate(taskId)}
                starting={startTaskMutation.isPending}
              />
            ) : null}
          </section>
        ) : null}

        {view === 'new-task' ? <NewTaskForm projects={projects} saving={createTaskMutation.isPending} onSubmit={createTask} /> : null}

        {view === 'approvals' ? (
          <section className="approval-grid">
            {approvals.length === 0 ? <div className="empty-state">Žádné schválení nečeká.</div> : null}
            {approvals.map((approval) => (
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

        {view === 'settings' ? <SettingsPanel projects={projects} /> : null}
      </main>

      <nav className="bottom-nav" aria-label="Mobilní navigace">
        <NavButton compact active={view === 'tasks'} icon={LayoutList} label="Tasks" onClick={() => setView('tasks')} />
        <NavButton compact active={view === 'new-task'} icon={Plus} label="New" onClick={() => setView('new-task')} />
        <NavButton compact active={view === 'approvals'} icon={ShieldCheck} label="Approve" onClick={() => setView('approvals')} />
        <NavButton compact active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
      </nav>
    </div>
  );
}

function viewTitle(view: View) {
  if (view === 'new-task') return 'Nový úkol';
  if (view === 'approvals') return 'Schválení';
  if (view === 'settings') return 'Nastavení';
  return 'Přehled tasků';
}

function NavButton(props: {
  active: boolean;
  compact?: boolean;
  icon: typeof LayoutList;
  label: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button className={props.active ? 'nav-button active' : 'nav-button'} type="button" onClick={props.onClick} title={props.label}>
      <Icon size={props.compact ? 20 : 18} />
      <span>{props.label}</span>
    </button>
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

function TaskDetail({
  projects,
  task,
  starting,
  onStart
}: {
  projects: ProjectSummary[];
  task: TaskSummary;
  starting: boolean;
  onStart: (taskId: string) => void;
}) {
  const project = projects.find((item) => item.id === task.projectId);
  return (
    <article className="detail">
      <div className="detail-heading">
        <div>
          <span className={`badge ${task.status}`}>{statusLabels[task.status]}</span>
          <h2>{task.title}</h2>
          <p>{project?.name ?? 'Neznámý projekt'}</p>
        </div>
        <div className="branch">
          <GitBranch size={18} />
          <span>{task.branchName ?? 'branch zatím nevytvořena'}</span>
        </div>
      </div>

      <div className="detail-grid">
        <MetricBlock label="Iterace" value={`${task.iterations}/${task.maxIterations}`} />
        <MetricBlock label="Rozpočet" value={`$${task.budgetUsd.toFixed(2)} / $${task.maxBudgetUsd.toFixed(2)}`} />
        <MetricBlock label="Testy" value={task.testResult} />
        <MetricBlock label="Diff" value={task.diffSummary} />
      </div>

      <section className="plain-section">
        <h3>Plán</h3>
        <ol>
          {task.plan.length ? task.plan.map((step) => <li key={step}>{step}</li>) : <li>Plán bude vytvořen po spuštění workeru.</li>}
        </ol>
      </section>

      <section className="plain-section">
        <h3>Zadání</h3>
        <p>{task.prompt}</p>
      </section>

      <div className="actions">
        <button className="primary-action" type="button" disabled={task.status !== 'draft' || starting} onClick={() => onStart(task.id)}>
          <Play size={18} />
          Spustit
        </button>
        <a className="secondary-action" href={task.issueUrl ?? '#'} aria-disabled={!task.issueUrl}>
          <Github size={18} />
          Issue
        </a>
        <a className="secondary-action" href={task.pullRequestUrl ?? '#'} aria-disabled={!task.pullRequestUrl}>
          <ClipboardCheck size={18} />
          Draft PR
        </a>
      </div>
    </article>
  );
}

function MetricBlock(props: { label: string; value: string }) {
  return (
    <div className="metric-block">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function NewTaskForm({ projects, saving, onSubmit }: { projects: ProjectSummary[]; saving: boolean; onSubmit: (formData: FormData) => void }) {
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
        <select name="projectId" defaultValue={projects[0]?.id}>
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
        Režim
        <select name="mode" defaultValue="safe">
          <option value="safe">Safe</option>
          <option value="auto">Auto</option>
          <option value="full_auto">Full-auto</option>
        </select>
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

function SettingsPanel({ projects }: { projects: ProjectSummary[] }) {
  return (
    <section className="settings-grid">
      {projects.map((project) => (
        <article className="project-row" key={project.id}>
          <div>
            <h2>{project.name}</h2>
            <p>
              {project.githubOwner}/{project.githubRepo}
            </p>
          </div>
          <MetricBlock label="Otevřené PR" value={String(project.openPullRequests)} />
          <MetricBlock label="AI rozpočet" value={`$${project.budgetUsd.toFixed(2)}`} />
        </article>
      ))}
    </section>
  );
}

