import type { EnvironmentId, ProjectId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import type { AppState, EnvironmentState } from "../../store";
import type { SidebarThreadSummary } from "../../types";

export interface SidebarThreadSortSnapshot {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestUserMessageAt: string | null;
}

const EMPTY_SIDEBAR_THREAD_SORT_SNAPSHOTS: SidebarThreadSortSnapshot[] = [];
const EMPTY_PROJECT_THREAD_KEYS: string[] = [];
const EMPTY_PROJECT_THREAD_STATUS_INPUTS: ProjectThreadStatusInput[] = [];

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ProjectThreadStatusInput {
  threadKey: string;
  hasActionableProposedPlan: boolean;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  interactionMode: SidebarThreadSummary["interactionMode"];
  latestTurn: SidebarThreadSummary["latestTurn"];
  session: SidebarThreadSummary["session"];
}

export interface SidebarThreadRowSnapshot {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  branch: string | null;
  worktreePath: string | null;
}

interface ProjectThreadRenderEntry {
  threadKey: string;
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestUserMessageAt: string | null;
}

export interface SidebarProjectRenderStateSnapshot {
  hasOverflowingThreads: boolean;
  hiddenThreadKeys: readonly string[];
  renderedThreadKeys: readonly string[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
}

const EMPTY_PROJECT_RENDER_STATE: SidebarProjectRenderStateSnapshot = {
  hasOverflowingThreads: false,
  hiddenThreadKeys: EMPTY_PROJECT_THREAD_KEYS,
  renderedThreadKeys: EMPTY_PROJECT_THREAD_KEYS,
  showEmptyThreadState: false,
  shouldShowThreadPanel: false,
};

function collectProjectThreadEntries(
  state: AppState,
  memberProjectRefs: readonly ScopedProjectRef[],
): ProjectThreadRenderEntry[] {
  if (memberProjectRefs.length === 0) {
    return [];
  }

  const entries: ProjectThreadRenderEntry[] = [];
  for (const ref of memberProjectRefs) {
    const environmentState = state.environmentStateById[ref.environmentId];
    if (!environmentState) {
      continue;
    }
    const threadIds = environmentState.threadIdsByProjectId[ref.projectId] ?? [];
    for (const threadId of threadIds) {
      const summary = environmentState.sidebarThreadSummaryById[threadId];
      if (!summary) {
        continue;
      }
      entries.push({
        threadKey: scopedThreadKey(scopeThreadRef(summary.environmentId, summary.id)),
        id: summary.id,
        environmentId: summary.environmentId,
        projectId: summary.projectId,
        createdAt: summary.createdAt,
        archivedAt: summary.archivedAt,
        updatedAt: summary.updatedAt,
        latestUserMessageAt: summary.latestUserMessageAt,
      });
    }
  }
  return entries;
}

function collectProjectThreadStatusInputs(
  state: AppState,
  memberProjectRefs: readonly ScopedProjectRef[],
): ProjectThreadStatusInput[] {
  if (memberProjectRefs.length === 0) {
    return [];
  }

  const inputs: ProjectThreadStatusInput[] = [];
  for (const ref of memberProjectRefs) {
    const environmentState = state.environmentStateById[ref.environmentId];
    if (!environmentState) {
      continue;
    }
    const threadIds = environmentState.threadIdsByProjectId[ref.projectId] ?? [];
    for (const threadId of threadIds) {
      const summary = environmentState.sidebarThreadSummaryById[threadId];
      if (!summary) {
        continue;
      }
      inputs.push({
        threadKey: scopedThreadKey(scopeThreadRef(summary.environmentId, summary.id)),
        hasActionableProposedPlan: summary.hasActionableProposedPlan,
        hasPendingApprovals: summary.hasPendingApprovals,
        hasPendingUserInput: summary.hasPendingUserInput,
        interactionMode: summary.interactionMode,
        latestTurn: summary.latestTurn,
        session: summary.session,
      });
    }
  }
  return inputs;
}

function projectThreadStatusInputsEqual(
  left: ProjectThreadStatusInput | undefined,
  right: ProjectThreadStatusInput | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.threadKey === right.threadKey &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.interactionMode === right.interactionMode &&
    left.latestTurn?.startedAt === right.latestTurn?.startedAt &&
    left.latestTurn?.completedAt === right.latestTurn?.completedAt &&
    left.session?.orchestrationStatus === right.session?.orchestrationStatus &&
    left.session?.activeTurnId === right.session?.activeTurnId &&
    left.session?.status === right.session?.status
  );
}

export function createSidebarThreadSortSnapshotsAcrossEnvironmentsSelector(): (
  state: AppState,
) => SidebarThreadSortSnapshot[] {
  let previousResult = EMPTY_SIDEBAR_THREAD_SORT_SNAPSHOTS;
  let previousEntries = new Map<string, SidebarThreadSortSnapshot>();

  return (state) => {
    const nextEntries = new Map<string, SidebarThreadSortSnapshot>();
    const nextResult: SidebarThreadSortSnapshot[] = [];
    let changed = false;

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[EnvironmentId, EnvironmentState]>) {
      for (const threadId of environmentState.threadIds) {
        const summary = environmentState.sidebarThreadSummaryById[threadId];
        if (!summary || summary.environmentId !== environmentId) {
          continue;
        }

        const entryKey = `${environmentId}:${threadId}`;
        const previousEntry = previousEntries.get(entryKey);
        if (
          previousEntry &&
          previousEntry.id === summary.id &&
          previousEntry.environmentId === summary.environmentId &&
          previousEntry.projectId === summary.projectId &&
          previousEntry.createdAt === summary.createdAt &&
          previousEntry.archivedAt === summary.archivedAt &&
          previousEntry.updatedAt === summary.updatedAt &&
          previousEntry.latestUserMessageAt === summary.latestUserMessageAt
        ) {
          nextEntries.set(entryKey, previousEntry);
          nextResult.push(previousEntry);
          if (previousResult[nextResult.length - 1] !== previousEntry) {
            changed = true;
          }
          continue;
        }

        const snapshot: SidebarThreadSortSnapshot = {
          id: summary.id,
          environmentId: summary.environmentId,
          projectId: summary.projectId,
          createdAt: summary.createdAt,
          archivedAt: summary.archivedAt,
          updatedAt: summary.updatedAt,
          latestUserMessageAt: summary.latestUserMessageAt,
        };
        nextEntries.set(entryKey, snapshot);
        nextResult.push(snapshot);
        changed = true;
      }
    }

    if (previousResult.length !== nextResult.length) {
      changed = true;
    }

    if (!changed) {
      previousEntries = nextEntries;
      return previousResult;
    }

    previousEntries = nextEntries;
    previousResult = nextResult.length === 0 ? EMPTY_SIDEBAR_THREAD_SORT_SNAPSHOTS : nextResult;
    return previousResult;
  };
}

export function createSidebarThreadRowSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => SidebarThreadRowSnapshot | undefined {
  let previousResult: SidebarThreadRowSnapshot | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }

    const summary =
      state.environmentStateById[ref.environmentId]?.sidebarThreadSummaryById[ref.threadId];
    if (!summary) {
      return undefined;
    }

    const nextResult: SidebarThreadRowSnapshot = {
      id: summary.id,
      environmentId: summary.environmentId,
      projectId: summary.projectId,
      title: summary.title,
      branch: summary.branch,
      worktreePath: summary.worktreePath ?? null,
    };

    if (
      previousResult &&
      previousResult.id === nextResult.id &&
      previousResult.environmentId === nextResult.environmentId &&
      previousResult.projectId === nextResult.projectId &&
      previousResult.title === nextResult.title &&
      previousResult.branch === nextResult.branch &&
      previousResult.worktreePath === nextResult.worktreePath
    ) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarThreadStatusInputSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ProjectThreadStatusInput | undefined {
  let previousResult: ProjectThreadStatusInput | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }

    const summary =
      state.environmentStateById[ref.environmentId]?.sidebarThreadSummaryById[ref.threadId];
    if (!summary) {
      return undefined;
    }

    const nextResult: ProjectThreadStatusInput = {
      threadKey: scopedThreadKey(scopeThreadRef(summary.environmentId, summary.id)),
      hasActionableProposedPlan: summary.hasActionableProposedPlan,
      hasPendingApprovals: summary.hasPendingApprovals,
      hasPendingUserInput: summary.hasPendingUserInput,
      interactionMode: summary.interactionMode,
      latestTurn: summary.latestTurn,
      session: summary.session,
    };

    if (projectThreadStatusInputsEqual(previousResult, nextResult)) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarProjectRenderStateSelector(input: {
  activeRouteThreadKey: string | null;
  isThreadListExpanded: boolean;
  memberProjectRefs: readonly ScopedProjectRef[];
  projectExpanded: boolean;
  previewLimit: number;
  threadSortOrder: SidebarThreadSortOrder;
}): (state: AppState) => SidebarProjectRenderStateSnapshot {
  let previousResult = EMPTY_PROJECT_RENDER_STATE;

  return (state) => {
    const visibleProjectThreads = sortThreadsForSidebar(
      collectProjectThreadEntries(state, input.memberProjectRefs).filter(
        (thread) => thread.archivedAt === null,
      ),
      input.threadSortOrder,
    );
    const pinnedCollapsedThread =
      !input.projectExpanded && input.activeRouteThreadKey
        ? (visibleProjectThreads.find(
            (thread) => thread.threadKey === input.activeRouteThreadKey,
          ) ?? null)
        : null;
    const shouldShowThreadPanel = input.projectExpanded || pinnedCollapsedThread !== null;
    const hasOverflowingThreads = visibleProjectThreads.length > input.previewLimit;
    const previewThreads =
      input.isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, input.previewLimit);
    const renderedThreadKeys = pinnedCollapsedThread
      ? [pinnedCollapsedThread.threadKey]
      : previewThreads.map((thread) => thread.threadKey);
    const renderedThreadKeySet = new Set(renderedThreadKeys);
    const hiddenThreadKeys = visibleProjectThreads
      .filter((thread) => !renderedThreadKeySet.has(thread.threadKey))
      .map((thread) => thread.threadKey);
    const nextResult: SidebarProjectRenderStateSnapshot = {
      hasOverflowingThreads,
      hiddenThreadKeys:
        hiddenThreadKeys.length === 0 ? EMPTY_PROJECT_THREAD_KEYS : hiddenThreadKeys,
      renderedThreadKeys:
        renderedThreadKeys.length === 0 ? EMPTY_PROJECT_THREAD_KEYS : renderedThreadKeys,
      showEmptyThreadState: input.projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel,
    };

    if (
      previousResult.hasOverflowingThreads === nextResult.hasOverflowingThreads &&
      previousResult.showEmptyThreadState === nextResult.showEmptyThreadState &&
      previousResult.shouldShowThreadPanel === nextResult.shouldShowThreadPanel &&
      stringArraysEqual(previousResult.renderedThreadKeys, nextResult.renderedThreadKeys) &&
      stringArraysEqual(previousResult.hiddenThreadKeys, nextResult.hiddenThreadKeys)
    ) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarProjectThreadStatusInputsSelector(
  memberProjectRefs: readonly ScopedProjectRef[],
): (state: AppState) => readonly ProjectThreadStatusInput[] {
  let previousResult: readonly ProjectThreadStatusInput[] = EMPTY_PROJECT_THREAD_STATUS_INPUTS;

  return (state) => {
    const nextInputs = collectProjectThreadStatusInputs(state, memberProjectRefs);
    if (
      previousResult.length === nextInputs.length &&
      previousResult.every((previousInput, index) => {
        const nextInput = nextInputs[index];
        return nextInput !== undefined && projectThreadStatusInputsEqual(previousInput, nextInput);
      })
    ) {
      return previousResult;
    }

    previousResult = nextInputs.length === 0 ? EMPTY_PROJECT_THREAD_STATUS_INPUTS : nextInputs;
    return previousResult;
  };
}
