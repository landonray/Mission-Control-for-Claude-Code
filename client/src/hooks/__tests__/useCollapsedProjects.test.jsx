// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCollapsedProjects } from '../useCollapsedProjects';

describe('useCollapsedProjects', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with no collapsed projects when storage is empty', () => {
    const { result } = renderHook(() => useCollapsedProjects());
    expect(result.current.collapsedProjects.size).toBe(0);
  });

  it('toggling a project collapses it and persists to localStorage', () => {
    const { result } = renderHook(() => useCollapsedProjects());

    act(() => result.current.toggleProject('Acme'));

    expect(result.current.collapsedProjects.has('Acme')).toBe(true);
    expect(JSON.parse(localStorage.getItem('collapsed-projects'))).toEqual(['Acme']);
  });

  it('toggling a collapsed project expands it again', () => {
    const { result } = renderHook(() => useCollapsedProjects());

    act(() => result.current.toggleProject('Acme'));
    act(() => result.current.toggleProject('Acme'));

    expect(result.current.collapsedProjects.has('Acme')).toBe(false);
    expect(JSON.parse(localStorage.getItem('collapsed-projects'))).toEqual([]);
  });

  it('hydrates collapsed state from localStorage on mount', () => {
    localStorage.setItem('collapsed-projects', JSON.stringify(['Acme', 'Beta']));

    const { result } = renderHook(() => useCollapsedProjects());

    expect(result.current.collapsedProjects.has('Acme')).toBe(true);
    expect(result.current.collapsedProjects.has('Beta')).toBe(true);
    expect(result.current.collapsedProjects.size).toBe(2);
  });

  it('falls back to empty set when stored value is corrupt', () => {
    localStorage.setItem('collapsed-projects', 'not-json');
    const { result } = renderHook(() => useCollapsedProjects());
    expect(result.current.collapsedProjects.size).toBe(0);
  });
});
