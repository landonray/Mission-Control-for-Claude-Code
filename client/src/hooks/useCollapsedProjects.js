import { useCallback, useState } from 'react';

const STORAGE_KEY = 'collapsed-projects';

function readInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

export function useCollapsedProjects() {
  const [collapsedProjects, setCollapsedProjects] = useState(readInitial);

  const toggleProject = useCallback((projectName) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // storage unavailable; in-memory state still works for this session
      }
      return next;
    });
  }, []);

  return { collapsedProjects, toggleProject };
}
