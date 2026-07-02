import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  GitBranch,
  Github,
  LayoutList,
  Plus,
  Settings,
  ShieldCheck,
  Smartphone,
  XCircle
} from 'lucide-react';
import { initialApprovals, initialTasks, projects } from './api.js';
import type { ApprovalSummary, TaskSummary } from './types.js';

type View = 'tasks' | 'new-task' | 'approvals' | 'settings';

const statusLabels: Record<TaskSummary['status'], string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  planning: 'Planning',
  running_ai: 'Running AI',
  validating: 'Validating',
  needs_approval: 'Needs approval',
  ready_for_user_review: 'Ready for review',
  completed: 'Completed',
  validation_failed: 'Validation failed'
};

const statusIcons: Record<TaskSummary['status'], typeof Clock3> = {
  draft: Clock3,
  submitted: Clock3,
  planning: LayoutList,
  running_ai: GitBranch,
  validating: ClipboardCheck,
  needs_approval: AlertTriangle,
  ready_for_user_review: CheckCircle2,
  completed: CheckCircle2,
  validation_failed: XCircle
};

export function App() {
  const [view, setView] = useState<View>('tasks');
  const [tasks, setTasks] = useState<TaskSummary[]>(initialTasks);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>(initialApprovals);
  const [selectedTaskId, setSelectedTaskId] = useState<string>(initialTasks[0]?.id ?? '');

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0], [selectedTaskId, tasks]);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const activeTasks = tasks.filter((task) => task.status !== 'completed');

  function createTask(formData: FormData) {
    const projectId = String(formData.get('projectId'));
    const title = String(formData.get('title'));
    const prompt = String(formData.get('prompt'));
    const mode = String(formData.get('mode')) as TaskSummary['mode'];
    const maxBudgetUsd = Number(formData.get('maxBudgetUsd') || 2);
    const maxIterations = Number(formData.get('maxIterations') || 10);

    const task: TaskSummary = {
      id: `task_${crypto.randomUUID()}`,
      projectId,
      title,
      prompt,
      status: 'draft',
      currentStep: 'Připraveno ke spuštění',
      mode,
      iterations: 0,
      maxIterations,
      budgetUsd: 0,
      maxBudgetUsd,
      updatedAt: new Date().toISOString(),
      plan: [],
      testResult: 'Zatím nespouštěno',
      diffSummary: 'Bez změn'
    };

    setTasks((current) => [task, ...current]);
    setSelectedTaskId(task.id);
    setView('tasks');
  }

  function resolveApproval(id: string, status: 'approved' | 'rejected') {
    setApprovals((current) => current.map((approval) => (approval.id === id ? { ...approval, status } : approval)));
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

        {view === 'tasks' && selectedTask ? (
          <section className="workspace">
            <div className="task-list" aria-label="Seznam tasků">
              <MetricRow label="Aktivní tasky" value={String(activeTasks.length)} />
              <MetricRow label="Čekající approvals" value={String(pendingApprovals.length)} tone={pendingApprovals.length ? 'warning' : 'ok'} />
              {tasks.map((task) => (
                <TaskButton key={task.id} task={task} selected={task.id === selectedTask.id} onClick={() => setSelectedTaskId(task.id)} />
              ))}
            </div>
            <TaskDetail task={selectedTask} />
          </section>
        ) : null}

        {view === 'new-task' ? <NewTaskForm onSubmit={createTask} /> : null}

        {view === 'approvals' ? (
          <section className="approval-grid">
            {approvals.map((approval) => (
              <ApprovalPanel key={approval.id} approval={approval} onResolve={resolveApproval} />
            ))}
          </section>
        ) : null}

        {view === 'settings' ? <SettingsPanel /> : null}
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

function TaskDetail({ task }: { task: TaskSummary }) {
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

function NewTaskForm({ onSubmit }: { onSubmit: (formData: FormData) => void }) {
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
      <button className="primary-action wide" type="submit">
        <Smartphone size={18} />
        Vytvořit task
      </button>
    </form>
  );
}

function ApprovalPanel(props: {
  approval: ApprovalSummary;
  onResolve: (id: string, status: 'approved' | 'rejected') => void;
}) {
  const task = initialTasks.find((item) => item.id === props.approval.taskId);
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
        <button className="primary-action" type="button" disabled={props.approval.status !== 'pending'} onClick={() => props.onResolve(props.approval.id, 'approved')}>
          <CheckCircle2 size={18} />
          Schválit
        </button>
        <button className="danger-action" type="button" disabled={props.approval.status !== 'pending'} onClick={() => props.onResolve(props.approval.id, 'rejected')}>
          <XCircle size={18} />
          Zamítnout
        </button>
      </div>
    </article>
  );
}

function SettingsPanel() {
  return (
    <section className="settings-grid">
      {projects.map((project) => (
        <article className="project-row" key={project.id}>
          <div>
            <h2>{project.name}</h2>
            <p>{project.slug}</p>
          </div>
          <MetricBlock label="Otevřené PR" value={String(project.openPullRequests)} />
          <MetricBlock label="AI rozpočet" value={`$${project.budgetUsd.toFixed(2)}`} />
        </article>
      ))}
    </section>
  );
}

