export interface ActivityDisplayEntry {
  createdAt: string;
  state: 'started' | 'progress' | 'completed' | 'failed';
  attempt: number;
  runId?: string;
}

export function activityWorkflowStage(activity: { phase: string; operation?: string }): number {
  if (activity.phase === 'workspace' || activity.phase === 'planning') return 0;
  if (activity.phase === 'github') {
    return !activity.operation || activity.operation === 'create_issue' || activity.operation === 'create_branch'
      ? 1
      : 5;
  }
  if (activity.phase === 'implementation') return 2;
  if (activity.phase === 'validation') return 3;
  if (activity.phase === 'review') return 4;
  return 5;
}

export function currentExecutionEntries<T extends ActivityDisplayEntry>(entries: T[], currentRunId?: string): T[] {
  const latestRunId = currentRunId ?? [...entries].reverse().find((entry) => entry.runId)?.runId;
  if (!latestRunId) {
    return entries;
  }

  const runStart = entries.find((entry) => entry.runId === latestRunId);
  if (!runStart) {
    return currentRunId ? [] : entries;
  }

  const runStartAt = Date.parse(runStart.createdAt);
  return entries.filter((entry) => {
    const createdAt = Date.parse(entry.createdAt);
    return entry.runId === latestRunId
      || (!Number.isNaN(createdAt) && !Number.isNaN(runStartAt) && createdAt >= runStartAt);
  });
}

export function resolveCurrentActivity<T extends ActivityDisplayEntry>(
  entries: T[],
  taskUpdatedAt: string,
  taskIsActive: boolean
): T | undefined {
  const latest = entries.at(-1);
  if (!latest || !taskIsActive || latest.state !== 'failed') {
    return latest;
  }

  const activityAt = Date.parse(latest.createdAt);
  const taskAt = Date.parse(taskUpdatedAt);
  return !Number.isNaN(activityAt) && !Number.isNaN(taskAt) && taskAt > activityAt
    ? undefined
    : latest;
}

export function sanitizeProviderActivityDetail(
  kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace',
  message: string
): string | undefined {
  const normalized = message.replace(/\r\n/g, '\n').trim();
  if (!normalized || kind !== 'stdout') {
    return normalized || undefined;
  }

  const withoutFences = normalized.replace(/```[^\n]*\n[\s\S]*?```/g, '').trim();
  if (!withoutFences) {
    return undefined;
  }

  const lines = withoutFences.split('\n');
  const diffLineCount = lines.filter((line) => /^(?:diff --git|index\s|@@|\+\+\+\s|---\s|[+-](?![+-]))/.test(line)).length;
  const codeLineCount = lines.filter(looksLikeSourceLine).length;
  const shouldStripCode = diffLineCount >= 2
    || codeLineCount >= 3 && codeLineCount / Math.max(1, lines.filter((line) => line.trim()).length) >= 0.4;

  if (shouldStripCode) {
    const prose = lines
      .filter((line) => !looksLikeSourceLine(line) && !/^(?:diff --git|index\s|@@|\+\+\+\s|---\s|[+-](?![+-]))/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return prose || undefined;
  }

  if (lines.length === 1 && looksLikeDenseSourceLine(withoutFences)) {
    return undefined;
  }

  return withoutFences;
}

function looksLikeSourceLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const content = trimmed.replace(/^[+-]\s?/, '').trim();
  return /^(?:import|export|const|let|var|function|class|interface|type|enum|namespace|using|#include|template\s*<|def\s|from\s+\S+\s+import|public:|private:|protected:|return\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|case\s|[{}()[\],;]+$)/.test(content)
    || /[;{}]\s*$/.test(content)
    || /^<\/?[A-Za-z][^>]*>$/.test(content)
    || /^(?:diff --git|index\s|@@|\+\+\+\s|---\s)/.test(trimmed)
    || /^[+-](?![+-])/.test(trimmed) && /[=;{}()[\]<>]|\b(?:const|let|return|class|function)\b/.test(content);
}

function looksLikeDenseSourceLine(value: string): boolean {
  if (/\b(?:error|failed|warning|exception|fatal)\b/i.test(value)) {
    return false;
  }
  const syntaxMarks = value.match(/[{};()[\]]/g)?.length ?? 0;
  return value.length > 180 && syntaxMarks >= 8;
}
