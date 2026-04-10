import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveThreadRouteRef } from "../../threadRoutes";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveAdjacentThreadId,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "../Sidebar.logic";
import {
  createSidebarActiveRouteProjectKeySelectorByRef,
  createSidebarThreadSortSnapshotsAcrossEnvironmentsSelector,
  type SidebarThreadSortSnapshot,
} from "./sidebarSelectors";
import { THREAD_PREVIEW_LIMIT } from "./sidebarConstants";
import type { LogicalProjectKey } from "../../logicalProject";
import {
  setSidebarKeyboardState,
  setSidebarProjectOrdering,
  useSidebarExpandedThreadListsByProject,
  useSidebarPhysicalToLogicalKey,
  useSidebarProjectKeys,
  type SidebarProjectSnapshot,
} from "./sidebarViewStore";
import { useServerKeybindings } from "../../rpc/serverState";
import { useStore } from "../../store";

const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

function useSidebarKeyboardController(input: {
  sortedProjectKeys: readonly LogicalProjectKey[];
  sidebarThreadSortSnapshots: readonly SidebarThreadSortSnapshot[];
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
  expandedThreadListsByProject: ReadonlySet<LogicalProjectKey>;
  routeThreadRef: ScopedThreadRef | null;
  routeThreadKey: string | null;
  platform: string;
  keybindings: ReturnType<typeof useServerKeybindings>;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  sidebarThreadSortOrder: SidebarThreadSortOrder;
}) {
  const {
    sortedProjectKeys,
    sidebarThreadSortSnapshots,
    physicalToLogicalKey,
    expandedThreadListsByProject,
    routeThreadRef,
    routeThreadKey,
    platform,
    keybindings,
    navigateToThread,
    sidebarThreadSortOrder,
  } = input;
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<LogicalProjectKey, SidebarThreadSortSnapshot[]>();
    for (const thread of sidebarThreadSortSnapshots) {
      const physicalKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [physicalToLogicalKey, sidebarThreadSortSnapshots]);
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjectKeys.flatMap((projectKey) => {
        const projectThreads = sortThreadsForSidebar(
          (threadsByProjectKey.get(projectKey) ?? []).filter(
            (thread) => thread.archivedAt === null,
          ),
          sidebarThreadSortOrder,
        );
        const projectExpanded = projectExpandedById[projectKey] ?? true;
        const activeThreadKey = routeThreadKey ?? undefined;
        const pinnedCollapsedThread =
          !projectExpanded && activeThreadKey
            ? (projectThreads.find(
                (thread) =>
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                  activeThreadKey,
              ) ?? null)
            : null;
        const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThread !== null;
        if (!shouldShowThreadPanel) {
          return [];
        }
        const isThreadListExpanded = expandedThreadListsByProject.has(projectKey);
        const hasOverflowingThreads = projectThreads.length > THREAD_PREVIEW_LIMIT;
        const previewThreads =
          isThreadListExpanded || !hasOverflowingThreads
            ? projectThreads
            : projectThreads.slice(0, THREAD_PREVIEW_LIMIT);
        const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreads;
        return renderedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
      }),
    [
      expandedThreadListsByProject,
      projectExpandedById,
      routeThreadKey,
      sidebarThreadSortOrder,
      sortedProjectKeys,
      threadsByProjectKey,
    ],
  );
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
    }),
    [routeThreadRef],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      showThreadJumpHints
        ? buildThreadJumpLabelMap({
            keybindings,
            platform,
            terminalOpen: getCurrentSidebarShortcutContext().terminalOpen,
            threadJumpCommandByKey,
          })
        : EMPTY_THREAD_JUMP_LABELS,
    [
      getCurrentSidebarShortcutContext,
      keybindings,
      platform,
      showThreadJumpHints,
      threadJumpCommandByKey,
    ],
  );
  const threadJumpLabelsRef = useRef<ReadonlyMap<string, string>>(threadJumpLabelByKey);
  threadJumpLabelsRef.current = threadJumpLabelByKey;
  const showThreadJumpHintsRef = useRef(showThreadJumpHints);
  showThreadJumpHintsRef.current = showThreadJumpHints;

  useEffect(() => {
    const clearThreadJumpHints = () => {
      updateThreadJumpHintsVisibility(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: globalThis.KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }

      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        if (
          showThreadJumpHintsRef.current ||
          threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
        ) {
          clearThreadJumpHints();
        }
      } else {
        updateThreadJumpHintsVisibility(true);
      }

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: visibleSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = parseScopedThreadKey(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(targetThread);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = parseScopedThreadKey(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThread);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }

      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      updateThreadJumpHintsVisibility(true);
    };

    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    platform,
    routeThreadKey,
    threadJumpCommandByKey,
    threadJumpThreadKeys,
    updateThreadJumpHintsVisibility,
    visibleSidebarThreadKeys,
  ]);

  return threadJumpLabelByKey;
}

export const SidebarProjectOrderingController = memo(
  function SidebarProjectOrderingController(props: {
    sidebarProjects: readonly SidebarProjectSnapshot[];
    physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
    sidebarProjectSortOrder: SidebarProjectSortOrder;
  }) {
    const { sidebarProjects, physicalToLogicalKey, sidebarProjectSortOrder } = props;
    const sidebarThreadSortSnapshots = useStore(
      useMemo(
        () => createSidebarThreadSortSnapshotsAcrossEnvironmentsSelector(sidebarProjectSortOrder),
        [sidebarProjectSortOrder],
      ),
    );
    const sortedProjectKeys = useMemo(() => {
      if (sidebarProjectSortOrder === "manual") {
        return sidebarProjects.map((project) => project.projectKey);
      }

      const sortableProjects = sidebarProjects.map((project) => ({
        ...project,
        id: project.projectKey,
      }));
      const sortableThreads = sidebarThreadSortSnapshots
        .filter((thread) => thread.archivedAt === null)
        .map((thread) => {
          const physicalKey = scopedProjectKey(
            scopeProjectRef(thread.environmentId, thread.projectId),
          );
          return {
            id: thread.id,
            environmentId: thread.environmentId,
            projectId: physicalToLogicalKey.get(physicalKey) ?? physicalKey,
            createdAt: thread.createdAt,
            archivedAt: thread.archivedAt,
            updatedAt: thread.updatedAt,
            latestUserMessageAt: thread.latestUserMessageAt,
          };
        });
      return sortProjectsForSidebar(sortableProjects, sortableThreads, sidebarProjectSortOrder).map(
        (project) => project.id,
      );
    }, [
      physicalToLogicalKey,
      sidebarProjectSortOrder,
      sidebarProjects,
      sidebarThreadSortSnapshots,
    ]);

    useEffect(() => {
      setSidebarProjectOrdering(sortedProjectKeys);
    }, [sortedProjectKeys]);

    return null;
  },
);

export const SidebarKeyboardController = memo(function SidebarKeyboardController(props: {
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  sidebarThreadSortOrder: SidebarThreadSortOrder;
}) {
  const { navigateToThread, sidebarThreadSortOrder } = props;
  const sortedProjectKeys = useSidebarProjectKeys();
  const physicalToLogicalKey = useSidebarPhysicalToLogicalKey();
  const expandedThreadListsByProject = useSidebarExpandedThreadListsByProject();
  const sidebarThreadSortSnapshots = useStore(
    useMemo(
      () => createSidebarThreadSortSnapshotsAcrossEnvironmentsSelector(sidebarThreadSortOrder),
      [sidebarThreadSortOrder],
    ),
  );
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const activeRouteProjectKey = useStore(
    useMemo(
      () => createSidebarActiveRouteProjectKeySelectorByRef(routeThreadRef, physicalToLogicalKey),
      [physicalToLogicalKey, routeThreadRef],
    ),
  );
  const keybindings = useServerKeybindings();
  const platform = navigator.platform;
  const threadJumpLabelByKey = useSidebarKeyboardController({
    sortedProjectKeys,
    sidebarThreadSortSnapshots,
    physicalToLogicalKey,
    expandedThreadListsByProject,
    routeThreadRef,
    routeThreadKey,
    platform,
    keybindings,
    navigateToThread,
    sidebarThreadSortOrder,
  });

  useEffect(() => {
    setSidebarKeyboardState({
      activeRouteProjectKey,
      activeRouteThreadKey: routeThreadKey,
      threadJumpLabelByKey,
    });
  }, [activeRouteProjectKey, routeThreadKey, threadJumpLabelByKey]);

  return null;
});
