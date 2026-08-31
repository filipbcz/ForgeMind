import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Bot, Check, ChevronDown, CircleStop, Code2, GitFork, MessageSquarePlus, RefreshCw, Send, Settings2, Trash2, User, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { buildChatInterimResults, type ChatInterimResult } from './chat-activity.js';
import {
  cancelChatRun,
  continueChatThreadWithRepository,
  createChatThread,
  deleteChatThread,
  fetchChatThread,
  fetchChatThreads,
  fetchGitHubBranches,
  fetchGitHubRepositories,
  resolveChatApproval,
  retryChatRun,
  sendChatMessage,
  updateChatThread
} from './api.js';
import { subscribeChatRealtime } from './realtime.js';
import type {
  AuditEventApi,
  ChatRunApi,
  ChatThreadApi,
  ChatThreadDetailApi,
  CreateChatThreadRequest,
  GitHubRepositoryApi,
  ProjectSummary,
  ProviderConnectionApi,
  UpdateChatThreadRequest
} from './types.js';

const ACTIVE_RUN_STATUSES = new Set<ChatRunApi['status']>(['queued', 'running', 'waiting_for_approval']);

export function ChatPanel(props: { projects: ProjectSummary[]; providerConnections: ProviderConnectionApi[] }) {
  const queryClient = useQueryClient();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [showNewThread, setShowNewThread] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [liveEvents, setLiveEvents] = useState<AuditEventApi[]>([]);
  const threadsQuery = useQuery({ queryKey: ['chat-threads', showArchived], queryFn: () => fetchChatThreads(showArchived), refetchInterval: 30_000 });
  const threads = threadsQuery.data ?? [];

  useEffect(() => {
    if (!selectedThreadId && threads[0]) setSelectedThreadId(threads[0].id);
    if (selectedThreadId && !threads.some((thread) => thread.id === selectedThreadId)) setSelectedThreadId(threads[0]?.id);
  }, [selectedThreadId, threads]);

  const detailQuery = useQuery({
    queryKey: ['chat-thread', selectedThreadId],
    queryFn: () => fetchChatThread(selectedThreadId!),
    enabled: Boolean(selectedThreadId),
    refetchInterval: (query) => hasActiveRun(query.state.data as ChatThreadDetailApi | undefined) ? 10_000 : false
  });

  useEffect(() => {
    setLiveEvents([]);
    if (!selectedThreadId) return;
    return subscribeChatRealtime(selectedThreadId, {
      onMessage: (message) => {
        if (message.type !== 'audit_event' || message.event.chatThreadId !== selectedThreadId) return;
        setLiveEvents((current) => [...current.filter((event) => event.id !== message.event.id), message.event].slice(-120));
        if (message.event.eventType === 'chat_run_completed'
          || message.event.eventType === 'chat_run_failed'
          || message.event.eventType === 'chat_run_cancelled'
          || message.event.eventType === 'chat_approval_requested'
          || message.event.eventType === 'chat_approval_resolved') {
          void queryClient.invalidateQueries({ queryKey: ['chat-thread', selectedThreadId] });
          void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
        }
      }
    });
  }, [queryClient, selectedThreadId]);

  const createMutation = useMutation({
    mutationFn: createChatThread,
    onSuccess: (thread) => {
      queryClient.setQueriesData<ChatThreadApi[]>({ queryKey: ['chat-threads'] }, (current) => (
        current ? [thread, ...current.filter((item) => item.id !== thread.id)] : [thread]
      ));
      void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
      setSelectedThreadId(thread.id);
      setShowNewThread(false);
    }
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateChatThreadRequest }) => updateChatThread(id, input),
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
      void queryClient.invalidateQueries({ queryKey: ['chat-thread', thread.id] });
    }
  });
  const continueMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CreateChatThreadRequest }) => continueChatThreadWithRepository(id, input),
    onSuccess: (thread) => {
      queryClient.setQueriesData<ChatThreadApi[]>({ queryKey: ['chat-threads'] }, (current) => (
        current ? [thread, ...current.filter((item) => item.id !== thread.id)] : [thread]
      ));
      void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
      setSelectedThreadId(thread.id);
    }
  });
  const deleteMutation = useMutation({
    mutationFn: ({ id, confirmation }: { id: string; confirmation: string }) => deleteChatThread(id, confirmation),
    onSuccess: () => {
      setSelectedThreadId(undefined);
      void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    }
  });
  const sendMutation = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => sendChatMessage(id, content),
    onSuccess: (_created, input) => {
      void queryClient.invalidateQueries({ queryKey: ['chat-thread', input.id] });
      void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    }
  });
  const runMutation = useMutation({
    mutationFn: ({ runId, action }: { runId: string; action: 'retry' | 'cancel' }) => action === 'retry' ? retryChatRun(runId) : cancelChatRun(runId),
    onSuccess: (run) => void queryClient.invalidateQueries({ queryKey: ['chat-thread', run.threadId] })
  });
  const approvalMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) => resolveChatApproval(id, decision),
    onSuccess: (approval) => void queryClient.invalidateQueries({ queryKey: ['chat-thread', approval.threadId] })
  });

  const detail = detailQuery.data;
  const events = useMemo(() => mergeEvents(detail?.events ?? [], liveEvents), [detail?.events, liveEvents]);
  const mutationError = createMutation.error ?? continueMutation.error ?? updateMutation.error ?? deleteMutation.error ?? sendMutation.error ?? runMutation.error ?? approvalMutation.error;

  return (
    <section className="chat-workspace" aria-label="AI Chat">
      <aside className="chat-thread-list">
        <div className="chat-thread-list-heading">
          <div>
            <strong>Vlákna</strong>
            <span>{showArchived ? `${threads.length} celkem` : `${threads.length} aktivních`}</span>
          </div>
          <div className="chat-thread-heading-actions">
            <button className={`icon-action${showArchived ? ' active' : ''}`} type="button" title={showArchived ? 'Skrýt archiv' : 'Zobrazit archiv'} onClick={() => setShowArchived((value) => !value)}><Archive size={17} /></button>
            <button className="icon-action" type="button" title="Nové vlákno" onClick={() => setShowNewThread((value) => !value)}><MessageSquarePlus size={18} /></button>
          </div>
        </div>
        {showNewThread ? (
          <NewThreadForm
            projects={props.projects}
            providerConnections={props.providerConnections}
            saving={createMutation.isPending}
            onCancel={() => setShowNewThread(false)}
            onSubmit={(input) => createMutation.mutate(input)}
          />
        ) : null}
        <div className="chat-thread-scroll">
          {threadsQuery.isLoading ? <p className="chat-muted">Načítám vlákna...</p> : null}
          {!threadsQuery.isLoading && threads.length === 0 ? <p className="chat-muted">Založte první konverzaci.</p> : null}
          {threads.map((thread) => (
            <button
              className={`chat-thread-button${thread.id === selectedThreadId ? ' active' : ''}${thread.status === 'archived' ? ' archived' : ''}`}
              type="button"
              key={thread.id}
              onClick={() => setSelectedThreadId(thread.id)}
            >
              <strong>{thread.title}</strong>
              <span>{thread.repositoryOwner && thread.repositoryName ? `${thread.repositoryOwner}/${thread.repositoryName}` : 'Bez repozitáře'}</span>
              <small>{thread.status === 'archived' ? 'Archivováno' : formatRelativeTime(thread.lastMessageAt ?? thread.updatedAt)}</small>
            </button>
          ))}
        </div>
      </aside>

      <div className="chat-conversation">
        {mutationError ? <div className="error-banner">Akci nelze provést: {mutationError.message}</div> : null}
        {!selectedThreadId ? <ChatEmptyState onCreate={() => setShowNewThread(true)} /> : null}
        {selectedThreadId && detailQuery.isLoading ? <div className="loading-line">Načítám konverzaci...</div> : null}
        {detail ? (
          <ChatThreadView
            detail={detail}
            events={events}
            projects={props.projects}
            providerConnections={props.providerConnections}
            busy={sendMutation.isPending || runMutation.isPending || updateMutation.isPending || continueMutation.isPending || approvalMutation.isPending}
            onSend={(content) => sendMutation.mutate({ id: detail.thread.id, content })}
            onRunAction={(runId, action) => runMutation.mutate({ runId, action })}
            onApproval={(id, decision) => approvalMutation.mutate({ id, decision })}
            onUpdate={(input) => updateMutation.mutate({ id: detail.thread.id, input })}
            onContinue={(input) => continueMutation.mutate({ id: detail.thread.id, input })}
            onDelete={() => {
              const confirmation = window.prompt(`Pro odstranění napište přesný název vlákna:\n${detail.thread.title}`);
              if (confirmation !== null) deleteMutation.mutate({ id: detail.thread.id, confirmation });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function NewThreadForm(props: {
  projects: ProjectSummary[];
  providerConnections: ProviderConnectionApi[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: CreateChatThreadRequest) => void;
}) {
  const [context, setContext] = useState('none');
  const [baseBranch, setBaseBranch] = useState('main');
  const repositoriesQuery = useQuery({ queryKey: ['github-repositories', 'chat'], queryFn: () => fetchGitHubRepositories(100), retry: 1 });
  const selectedRepository = context.startsWith('repo:')
    ? (repositoriesQuery.data ?? []).find((item) => `repo:${item.fullName}` === context)
    : undefined;
  const selectedProject = context.startsWith('project:')
    ? props.projects.find((project) => project.id === context.slice('project:'.length))
    : undefined;
  const repositoryOwner = selectedRepository?.owner ?? selectedProject?.githubOwner;
  const repositoryName = selectedRepository?.repo ?? selectedProject?.githubRepo;
  const defaultBranch = selectedRepository?.defaultBranch ?? selectedProject?.defaultBranch ?? 'main';
  const branchesQuery = useQuery({
    queryKey: ['github-branches', 'chat', repositoryOwner, repositoryName],
    queryFn: () => fetchGitHubBranches(repositoryOwner!, repositoryName!, 100),
    enabled: Boolean(repositoryOwner && repositoryName),
    retry: 1
  });
  function changeContext(value: string) {
    setContext(value);
    const repository = value.startsWith('repo:')
      ? (repositoriesQuery.data ?? []).find((item) => `repo:${item.fullName}` === value)
      : undefined;
    const project = value.startsWith('project:')
      ? props.projects.find((item) => item.id === value.slice('project:'.length))
      : undefined;
    setBaseBranch(repository?.defaultBranch ?? project?.defaultBranch ?? 'main');
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selectedContext = String(data.get('context') || 'none');
    const input: CreateChatThreadRequest = {
      title: String(data.get('title') || '').trim(),
      mode: String(data.get('mode') || 'safe') as CreateChatThreadRequest['mode'],
      providerConnectionId: String(data.get('providerConnectionId') || '') || undefined
    };
    if (selectedContext.startsWith('project:')) input.projectId = selectedContext.slice('project:'.length);
    if (selectedContext.startsWith('repo:')) {
      const repository = (repositoriesQuery.data ?? []).find((item) => `repo:${item.fullName}` === selectedContext);
      if (repository) {
        input.repositoryOwner = repository.owner;
        input.repositoryName = repository.repo;
      }
    }
    if (repositoryOwner && repositoryName) input.baseBranch = baseBranch || defaultBranch;
    props.onSubmit(input);
  }
  return (
    <form className="chat-new-thread" onSubmit={submit}>
      <input name="title" required maxLength={160} placeholder="Název vlákna" />
      <select name="context" value={context} onChange={(event) => changeContext(event.target.value)}>
        <option value="none">Bez repozitáře</option>
        <optgroup label="Projekty">
          {props.projects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}
        </optgroup>
        <optgroup label="GitHub repozitáře">
          {(repositoriesQuery.data ?? []).map((repository: GitHubRepositoryApi) => <option key={repository.fullName} value={`repo:${repository.fullName}`}>{repository.fullName}</option>)}
        </optgroup>
      </select>
      {repositoryOwner && repositoryName ? (
        <select key={`${repositoryOwner}/${repositoryName}`} name="baseBranch" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
          {branchesQuery.isLoading ? <option value={defaultBranch}>Načítám branche...</option> : null}
          {!branchesQuery.isLoading && !(branchesQuery.data ?? []).some((branch) => branch.name === defaultBranch) ? <option value={defaultBranch}>{defaultBranch}</option> : null}
          {(branchesQuery.data ?? []).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
        </select>
      ) : null}
      <select name="providerConnectionId" defaultValue={props.providerConnections.find((item) => item.isDefault)?.id ?? ''}>
        <option value="">Výchozí AI provider</option>
        {props.providerConnections.filter((item) => item.provider !== 'github_copilot').map((connection) => (
          <option key={connection.id} value={connection.id}>{connection.name} · {connection.model}</option>
        ))}
      </select>
      <select name="mode" defaultValue="safe">
        <option value="safe">Safe</option>
        <option value="auto">Auto</option>
        <option value="full_auto">Full auto</option>
      </select>
      <div className="chat-form-actions">
        <button className="secondary-action" type="button" onClick={props.onCancel}><X size={16} /> Zrušit</button>
        <button className="primary-action" type="submit" disabled={props.saving}><Check size={16} /> Vytvořit</button>
      </div>
    </form>
  );
}

function ContinueWithRepositoryForm(props: {
  source: ChatThreadApi;
  projects: ProjectSummary[];
  providerConnections: ProviderConnectionApi[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: CreateChatThreadRequest) => void;
}) {
  const [context, setContext] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const repositoriesQuery = useQuery({
    queryKey: ['github-repositories', 'chat'],
    queryFn: () => fetchGitHubRepositories(100),
    retry: 1
  });
  const repositoryProjects = props.projects.filter((project) => project.githubOwner && project.githubRepo);
  const selectedRepository = context.startsWith('repo:')
    ? (repositoriesQuery.data ?? []).find((item) => `repo:${item.fullName}` === context)
    : undefined;
  const selectedProject = context.startsWith('project:')
    ? repositoryProjects.find((project) => project.id === context.slice('project:'.length))
    : undefined;
  const repositoryOwner = selectedRepository?.owner ?? selectedProject?.githubOwner;
  const repositoryName = selectedRepository?.repo ?? selectedProject?.githubRepo;
  const defaultBranch = selectedRepository?.defaultBranch ?? selectedProject?.defaultBranch ?? 'main';
  const branchesQuery = useQuery({
    queryKey: ['github-branches', 'chat', repositoryOwner, repositoryName],
    queryFn: () => fetchGitHubBranches(repositoryOwner!, repositoryName!, 100),
    enabled: Boolean(repositoryOwner && repositoryName),
    retry: 1
  });

  function changeContext(value: string) {
    setContext(value);
    const repository = value.startsWith('repo:')
      ? (repositoriesQuery.data ?? []).find((item) => `repo:${item.fullName}` === value)
      : undefined;
    const project = value.startsWith('project:')
      ? repositoryProjects.find((item) => item.id === value.slice('project:'.length))
      : undefined;
    setBaseBranch(repository?.defaultBranch ?? project?.defaultBranch ?? 'main');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repositoryOwner || !repositoryName) return;
    const data = new FormData(event.currentTarget);
    const input: CreateChatThreadRequest = {
      title: String(data.get('title') || '').trim(),
      providerConnectionId: String(data.get('providerConnectionId') || '') || undefined,
      mode: String(data.get('mode') || props.source.mode) as CreateChatThreadRequest['mode'],
      baseBranch: baseBranch || defaultBranch
    };
    if (context.startsWith('project:')) {
      input.projectId = context.slice('project:'.length);
    } else {
      input.repositoryOwner = repositoryOwner;
      input.repositoryName = repositoryName;
    }
    props.onSubmit(input);
  }

  return (
    <form className="chat-continuation-form" onSubmit={submit}>
      <label>
        Nové vlákno
        <input name="title" required maxLength={160} defaultValue={`${props.source.title} · repozitář`} />
      </label>
      <label>
        Projekt nebo repozitář
        <select name="context" required value={context} onChange={(event) => changeContext(event.target.value)}>
          <option value="">Vyberte kontext</option>
          {repositoryProjects.length > 0 ? (
            <optgroup label="Projekty">
              {repositoryProjects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}
            </optgroup>
          ) : null}
          <optgroup label="GitHub repozitáře">
            {(repositoriesQuery.data ?? []).map((repository: GitHubRepositoryApi) => (
              <option key={repository.fullName} value={`repo:${repository.fullName}`}>{repository.fullName}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <label>
        Výchozí branch
        <select
          key={`${repositoryOwner}/${repositoryName}`}
          name="baseBranch"
          disabled={!repositoryOwner || !repositoryName}
          value={repositoryOwner && repositoryName ? baseBranch : ''}
          onChange={(event) => setBaseBranch(event.target.value)}
        >
          {!repositoryOwner || !repositoryName ? <option value="">Nejprve vyberte repozitář</option> : null}
          {branchesQuery.isLoading ? <option value={defaultBranch}>Načítám branche...</option> : null}
          {repositoryOwner && repositoryName && !branchesQuery.isLoading && !(branchesQuery.data ?? []).some((branch) => branch.name === defaultBranch)
            ? <option value={defaultBranch}>{defaultBranch}</option>
            : null}
          {(branchesQuery.data ?? []).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
        </select>
      </label>
      <label>
        Provider
        <select name="providerConnectionId" defaultValue={props.source.providerConnectionId ?? props.providerConnections.find((item) => item.isDefault)?.id ?? ''}>
          <option value="">Výchozí AI provider</option>
          {props.providerConnections.filter((item) => item.provider !== 'github_copilot').map((connection) => (
            <option key={connection.id} value={connection.id}>{connection.name} · {connection.model}</option>
          ))}
        </select>
      </label>
      <label>
        Režim
        <select name="mode" defaultValue={props.source.mode}>
          <option value="safe">Safe</option>
          <option value="auto">Auto</option>
          <option value="full_auto">Full auto</option>
        </select>
      </label>
      <div className="chat-form-actions">
        <button className="secondary-action" type="button" onClick={props.onCancel}><X size={16} /> Zrušit</button>
        <button className="primary-action" type="submit" disabled={props.saving || !repositoryOwner || !repositoryName}><GitFork size={16} /> Pokračovat</button>
      </div>
      <p>Vznikne nové vlákno s přeneseným souhrnem konverzace a novou AI session. Původní vlákno zůstane zachováno.</p>
    </form>
  );
}

function ChatThreadView(props: {
  detail: ChatThreadDetailApi;
  events: AuditEventApi[];
  projects: ProjectSummary[];
  providerConnections: ProviderConnectionApi[];
  busy: boolean;
  onSend: (content: string) => void;
  onRunAction: (runId: string, action: 'retry' | 'cancel') => void;
  onApproval: (id: string, decision: 'approve' | 'reject') => void;
  onUpdate: (input: UpdateChatThreadRequest) => void;
  onContinue: (input: CreateChatThreadRequest) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showContinuation, setShowContinuation] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const activeRun = [...props.detail.runs].reverse().find((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const latestRun = props.detail.runs.at(-1);
  const pendingApprovals = props.detail.approvals.filter((approval) => approval.status === 'pending');
  const interimResultsByRun = useMemo(
    () => new Map(props.detail.runs.map((run) => [
      run.id,
      buildChatInterimResults(props.events, run.id, run.result?.interimResponses ?? [])
    ])),
    [props.detail.runs, props.events]
  );
  const activeInterimResults = activeRun ? interimResultsByRun.get(activeRun.id) ?? [] : [];

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' });
  }, [props.detail.messages.length, activeInterimResults.at(-1)?.id]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || activeRun) return;
    props.onSend(content);
    setDraft('');
  }

  return (
    <>
      <header className="chat-header">
        <div>
          <h2>{props.detail.thread.title}</h2>
          <p>
            {props.detail.thread.repositoryOwner && props.detail.thread.repositoryName
              ? `${props.detail.thread.repositoryOwner}/${props.detail.thread.repositoryName} · ${props.detail.thread.branchName}`
              : 'Konverzace bez repozitáře'}
          </p>
        </div>
        <div className="chat-header-actions">
          {!props.detail.thread.repositoryName ? (
            <button
              className="secondary-action chat-continue-action"
              type="button"
              disabled={Boolean(activeRun) || props.busy}
              onClick={() => setShowContinuation((value) => !value)}
            >
              <GitFork size={16} /> Pokračovat s repozitářem
            </button>
          ) : null}
          <span className={`chat-mode ${props.detail.thread.mode}`}>{props.detail.thread.mode.replace('_', ' ')}</span>
          <button className="icon-action" type="button" title="Nastavení vlákna" onClick={() => setShowSettings((value) => !value)}><Settings2 size={18} /></button>
        </div>
      </header>

      {showContinuation ? (
        <ContinueWithRepositoryForm
          source={props.detail.thread}
          projects={props.projects}
          providerConnections={props.providerConnections}
          saving={props.busy}
          onCancel={() => setShowContinuation(false)}
          onSubmit={props.onContinue}
        />
      ) : null}

      {showSettings ? (
        <ThreadSettings
          thread={props.detail.thread}
          providerConnections={props.providerConnections}
          busy={props.busy}
          onSave={props.onUpdate}
          onArchive={() => props.onUpdate({ status: props.detail.thread.status === 'archived' ? 'active' : 'archived' })}
          onDelete={props.onDelete}
        />
      ) : null}

      <div className="chat-messages" aria-live="polite">
        {props.detail.messages.length === 0 ? (
          <div className="chat-welcome">
            <Bot size={24} />
            <strong>Jak vám mohu pomoci?</strong>
            <p>{props.detail.thread.repositoryName ? 'Mohu procházet a upravovat připojený repozitář.' : 'Toto vlákno zatím nemá připojený repozitář.'}</p>
          </div>
        ) : null}
        {props.detail.messages.map((message) => {
          const interimResults = message.role === 'assistant' && message.runId
            ? (interimResultsByRun.get(message.runId) ?? []).filter((item) => item.content.trim() !== message.content.trim())
            : [];
          return (
            <Fragment key={message.id}>
              {interimResults.length > 0 ? <ChatInterimResults items={interimResults} /> : null}
              <article className={`chat-message ${message.role}`}>
                <div className="chat-message-avatar">{message.role === 'user' ? <User size={17} /> : <Bot size={17} />}</div>
                <div>
                  <strong>{message.role === 'user' ? 'Vy' : 'ForgeMind AI'}</strong>
                  <MessageContent content={message.content} />
                  <time>{new Date(message.createdAt).toLocaleString()}</time>
                </div>
              </article>
            </Fragment>
          );
        })}

        {activeRun ? (
          <section className="chat-live-run">
            <div className="chat-live-heading">
              <span className="activity-pulse" />
              <div><strong>{runStatusLabel(activeRun.status)}</strong><small>Pokus {activeRun.attemptCount || 1}</small></div>
              {activeRun.status !== 'waiting_for_approval' ? (
                <button className="secondary-action" type="button" disabled={props.busy} onClick={() => props.onRunAction(activeRun.id, 'cancel')}><CircleStop size={16} /> Zastavit</button>
              ) : null}
            </div>
            {activeInterimResults.length > 0
              ? <ChatInterimResults items={activeInterimResults} />
              : <p>AI zpracovává požadavek. Průběžný výsledek se zobrazí, jakmile bude k dispozici.</p>}
          </section>
        ) : null}

        {pendingApprovals.map((approval) => (
          <section className="chat-approval" key={approval.id}>
            <div><strong>{approval.title}</strong><span className={`risk ${approval.riskLevel}`}>{approval.riskLevel}</span></div>
            <p>{approval.description}</p>
            <div className="chat-form-actions">
              <button className="secondary-action" type="button" disabled={props.busy} onClick={() => props.onApproval(approval.id, 'reject')}><X size={16} /> Zamítnout</button>
              <button className="primary-action" type="button" disabled={props.busy} onClick={() => props.onApproval(approval.id, 'approve')}><Check size={16} /> Schválit</button>
            </div>
          </section>
        ))}

        {!activeRun && latestRun?.status === 'failed' ? (
          <section className="chat-run-error">
            <strong>Běh skončil chybou</strong>
            <pre>{latestRun.errorMessage}</pre>
            <button className="secondary-action" type="button" disabled={props.busy} onClick={() => props.onRunAction(latestRun.id, 'retry')}><RefreshCw size={16} /> Zkusit znovu</button>
          </section>
        ) : null}

        {latestRun?.result?.changedFiles?.length ? <ChatDiff run={latestRun} /> : null}
        <div ref={messageEndRef} />
      </div>

      <form className="chat-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
          placeholder={activeRun ? 'Počkejte na dokončení aktuální odpovědi...' : 'Napište zprávu pro AI...'}
          disabled={Boolean(activeRun) || props.busy}
        />
        <button className="chat-send" type="submit" title="Odeslat" disabled={!draft.trim() || Boolean(activeRun) || props.busy}><Send size={19} /></button>
        <small>Enter odešle, Shift + Enter vloží nový řádek.</small>
      </form>
    </>
  );
}

function ThreadSettings(props: {
  thread: ChatThreadApi;
  providerConnections: ProviderConnectionApi[];
  busy: boolean;
  onSave: (input: UpdateChatThreadRequest) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    props.onSave({
      title: String(data.get('title') || '').trim(),
      mode: String(data.get('mode')) as UpdateChatThreadRequest['mode'],
      providerConnectionId: String(data.get('providerConnectionId') || '') || null
    });
  }
  return (
    <form className="chat-thread-settings" onSubmit={submit}>
      <label>Název<input name="title" defaultValue={props.thread.title} required /></label>
      <label>Provider<select name="providerConnectionId" defaultValue={props.thread.providerConnectionId ?? ''}>
        <option value="">Výchozí provider</option>
        {props.providerConnections.filter((item) => item.provider !== 'github_copilot').map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.model}</option>)}
      </select></label>
      <label>Režim<select name="mode" defaultValue={props.thread.mode}><option value="safe">Safe</option><option value="auto">Auto</option><option value="full_auto">Full auto</option></select></label>
      <div className="chat-form-actions">
        <button className="secondary-action" type="submit" disabled={props.busy}><Check size={16} /> Uložit</button>
        <button className="secondary-action" type="button" disabled={props.busy} onClick={props.onArchive}><Archive size={16} /> {props.thread.status === 'archived' ? 'Obnovit' : 'Archivovat'}</button>
        <button className="danger-action" type="button" disabled={props.busy} onClick={props.onDelete}><Trash2 size={16} /> Odstranit</button>
      </div>
    </form>
  );
}

function ChatInterimResults({ items }: { items: ChatInterimResult[] }) {
  return (
    <div className="chat-interim-results" aria-label="Průběžné výsledky AI">
      {items.map((item) => (
        <div className="chat-interim-result" key={item.id}>
          <strong>Průběžný výsledek</strong>
          <MessageContent content={item.content} />
        </div>
      ))}
    </div>
  );
}

function ChatDiff({ run }: { run: ChatRunApi }) {
  const result = run.result;
  return (
    <details className="chat-diff">
      <summary><span><Code2 size={17} /> Změny v repozitáři ({result?.changedFiles?.length ?? 0})</span><ChevronDown size={16} /></summary>
      <div className="chat-changed-files">{result?.changedFiles?.map((file) => <code key={file}>{file}</code>)}</div>
      {result?.validation ? <p>Validace: {result.validation.passed ? 'prošla' : 'selhala'}{result.validation.command ? ` · ${result.validation.command}` : ''}</p> : null}
      {result?.diff ? <pre>{result.diff}</pre> : null}
      {result?.untracked?.map((file) => (
        <details className="chat-untracked" key={file.path}>
          <summary>Nový soubor: {file.path}</summary>
          <pre>{file.content}</pre>
        </details>
      ))}
    </details>
  );
}

function MessageContent({ content }: { content: string }) {
  return (
    <div className="chat-message-content">
      <ReactMarkdown components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>
      }}>{content}</ReactMarkdown>
    </div>
  );
}

function ChatEmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="chat-empty"><Bot size={32} /><h2>AI Chat</h2><p>Založte konverzaci pro práci s AI nebo s repozitářem.</p><button className="primary-action" type="button" onClick={onCreate}><MessageSquarePlus size={18} /> Nové vlákno</button></div>;
}

function hasActiveRun(detail?: ChatThreadDetailApi) {
  return Boolean(detail?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)));
}

function mergeEvents(stored: AuditEventApi[], live: AuditEventApi[]) {
  const merged = new Map(stored.map((event) => [event.id, event]));
  for (const event of live) merged.set(event.id, event);
  return [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function runStatusLabel(status: ChatRunApi['status']) {
  if (status === 'queued') return 'Čeká ve frontě';
  if (status === 'waiting_for_approval') return 'Čeká na schválení';
  return 'AI právě pracuje';
}

function formatRelativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'právě teď';
  if (seconds < 3600) return `před ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `před ${Math.floor(seconds / 3600)} h`;
  return new Date(value).toLocaleDateString();
}
