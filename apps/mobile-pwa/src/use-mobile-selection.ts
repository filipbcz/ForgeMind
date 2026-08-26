import { useEffect, useMemo, useState } from 'react';
import type { ProjectSummary, TaskSummary } from './types.js';

export function useSelectedProject(projects: ProjectSummary[]) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId]
  );

  return { selectedProjectId, selectedProject, setSelectedProjectId };
}

export function useSelectedTask(tasks: TaskSummary[]) {
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [selectedTaskId, tasks]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0],
    [selectedTaskId, tasks]
  );

  return { selectedTaskId, selectedTask, setSelectedTaskId };
}
