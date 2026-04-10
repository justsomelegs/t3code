import { useCallback } from "react";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { LogicalProjectKey } from "../../logicalProject";

interface SidebarTransientState {
  sortedProjectKeys: readonly LogicalProjectKey[];
  activeRouteThreadKey: string | null;
  activeRouteProjectKey: LogicalProjectKey | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  expandedThreadListsByProject: ReadonlySet<LogicalProjectKey>;
}

const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const EMPTY_SIDEBAR_PROJECT_KEYS: LogicalProjectKey[] = [];
const EMPTY_EXPANDED_THREAD_LISTS_BY_PROJECT = new Set<LogicalProjectKey>();

const sidebarViewStore = createStore<SidebarTransientState>(() => ({
  sortedProjectKeys: EMPTY_SIDEBAR_PROJECT_KEYS,
  activeRouteThreadKey: null,
  activeRouteProjectKey: null,
  threadJumpLabelByKey: EMPTY_THREAD_JUMP_LABELS,
  expandedThreadListsByProject: EMPTY_EXPANDED_THREAD_LISTS_BY_PROJECT,
}));

export function resetSidebarViewState(): void {
  sidebarViewStore.setState({
    sortedProjectKeys: EMPTY_SIDEBAR_PROJECT_KEYS,
    activeRouteThreadKey: null,
    activeRouteProjectKey: null,
    threadJumpLabelByKey: EMPTY_THREAD_JUMP_LABELS,
    expandedThreadListsByProject: EMPTY_EXPANDED_THREAD_LISTS_BY_PROJECT,
  });
}

export function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function useSidebarProjectKeys(): readonly LogicalProjectKey[] {
  return useZustandStore(sidebarViewStore, (state) => state.sortedProjectKeys);
}

export function useSidebarProjectThreadListExpanded(projectKey: LogicalProjectKey): boolean {
  return useZustandStore(
    sidebarViewStore,
    useCallback(
      (state: SidebarTransientState) => state.expandedThreadListsByProject.has(projectKey),
      [projectKey],
    ),
  );
}

export function useSidebarExpandedThreadListsByProject(): ReadonlySet<LogicalProjectKey> {
  return useZustandStore(sidebarViewStore, (state) => state.expandedThreadListsByProject);
}

export function expandSidebarProjectThreadList(projectKey: LogicalProjectKey): void {
  const { expandedThreadListsByProject } = sidebarViewStore.getState();
  if (expandedThreadListsByProject.has(projectKey)) {
    return;
  }

  sidebarViewStore.setState({
    expandedThreadListsByProject: new Set([...expandedThreadListsByProject, projectKey]),
  });
}

export function collapseSidebarProjectThreadList(projectKey: LogicalProjectKey): void {
  const { expandedThreadListsByProject } = sidebarViewStore.getState();
  if (!expandedThreadListsByProject.has(projectKey)) {
    return;
  }

  const nextExpandedThreadListsByProject = new Set(expandedThreadListsByProject);
  nextExpandedThreadListsByProject.delete(projectKey);
  sidebarViewStore.setState({
    expandedThreadListsByProject:
      nextExpandedThreadListsByProject.size === 0
        ? EMPTY_EXPANDED_THREAD_LISTS_BY_PROJECT
        : nextExpandedThreadListsByProject,
  });
}

export function useSidebarIsActiveThread(threadKey: string): boolean {
  return useZustandStore(
    sidebarViewStore,
    useCallback(
      (state: SidebarTransientState) => state.activeRouteThreadKey === threadKey,
      [threadKey],
    ),
  );
}

export function useSidebarThreadJumpLabel(threadKey: string): string | null {
  return useZustandStore(
    sidebarViewStore,
    useCallback(
      (state: SidebarTransientState) => state.threadJumpLabelByKey.get(threadKey) ?? null,
      [threadKey],
    ),
  );
}

export function useSidebarProjectActiveRouteThreadKey(
  projectKey: LogicalProjectKey,
): string | null {
  return useZustandStore(
    sidebarViewStore,
    useCallback(
      (state: SidebarTransientState) => {
        return state.activeRouteProjectKey === projectKey ? state.activeRouteThreadKey : null;
      },
      [projectKey],
    ),
  );
}

export function setSidebarProjectOrdering(sortedProjectKeys: readonly LogicalProjectKey[]): void {
  const currentState = sidebarViewStore.getState();
  if (stringArraysEqual(currentState.sortedProjectKeys, sortedProjectKeys)) {
    return;
  }

  sidebarViewStore.setState({
    sortedProjectKeys,
  });
}

export function setSidebarKeyboardState(input: {
  activeRouteProjectKey: LogicalProjectKey | null;
  activeRouteThreadKey: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
}): void {
  const currentState = sidebarViewStore.getState();
  if (
    currentState.activeRouteThreadKey === input.activeRouteThreadKey &&
    currentState.activeRouteProjectKey === input.activeRouteProjectKey &&
    currentState.threadJumpLabelByKey === input.threadJumpLabelByKey
  ) {
    return;
  }

  sidebarViewStore.setState({
    activeRouteThreadKey: input.activeRouteThreadKey,
    activeRouteProjectKey: input.activeRouteProjectKey,
    threadJumpLabelByKey: input.threadJumpLabelByKey,
  });
}
