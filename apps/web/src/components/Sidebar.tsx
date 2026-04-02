import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ProjectFavicon } from "./ProjectFavicon";
import { autoAnimate } from "@formkit/auto-animate";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
} from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isLinuxPlatform, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { selectThreadById, type AppState, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";

import { useThreadActions } from "../hooks/useThreadActions";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  getVisibleThreadsForProject,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { useProjectById } from "../storeSelectors";
import type { Thread } from "../types";
const THREAD_PREVIEW_LIMIT = 6;
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

type SidebarThreadSnapshot = Pick<
  Thread,
  | "archivedAt"
  | "branch"
  | "createdAt"
  | "id"
  | "interactionMode"
  | "latestUserMessageAt"
  | "pendingApprovalCount"
  | "pendingUserInputCount"
  | "projectId"
  | "session"
  | "title"
  | "worktreePath"
> & {
  hasActionableLatestProposedPlan: boolean;
  lastVisitedAt?: string | undefined;
  latestTurnCompletedAt: string | null;
  latestUserMessageAt: string | null;
  pendingApprovalCount: number;
  pendingUserInputCount: number;
};

const EMPTY_THREAD_IDS: ThreadId[] = [];

interface CachedSidebarThreadSnapshot {
  archivedAt: string | null;
  branch: string | null;
  createdAt: string;
  hasActionableLatestProposedPlan: boolean;
  interactionMode: Thread["interactionMode"];
  lastVisitedAt?: string | undefined;
  latestTurnCompletedAt: string | null;
  latestUserMessageAt: string | null;
  pendingApprovalCount: number;
  pendingUserInputCount: number;
  projectId: ProjectId;
  session: Thread["session"];
  snapshot: SidebarThreadSnapshot;
  title: string;
  worktreePath: string | null;
}

interface SidebarThreadGitTarget {
  branch: string | null;
  projectId: ProjectId;
  threadId: ThreadId;
  worktreePath: string | null;
}

const sidebarThreadSnapshotCache = new Map<ThreadId, CachedSidebarThreadSnapshot>();

function areArraysShallowEqual<T>(
  left: ReadonlyArray<T> | null | undefined,
  right: ReadonlyArray<T>,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function useSortedSidebarProjectIds(input: {
  projectOrder: readonly ProjectId[];
  sortOrder: SidebarProjectSortOrder;
}): ProjectId[] {
  const selector = useMemo(() => {
    let previousProjectIds: ProjectId[] = [];

    return (state: AppState): ProjectId[] => {
      const orderedProjects = orderItemsByPreferredIds({
        items: state.projects,
        preferredIds: input.projectOrder,
        getId: (project) => project.id,
      });
      const visibleThreads = state.threads.filter((thread) => thread.archivedAt === null);
      const nextProjectIds = sortProjectsForSidebar(
        orderedProjects,
        visibleThreads,
        input.sortOrder,
      ).map((project) => project.id);

      if (areArraysShallowEqual(previousProjectIds, nextProjectIds)) {
        return previousProjectIds;
      }

      previousProjectIds = nextProjectIds;
      return nextProjectIds;
    };
  }, [input.projectOrder, input.sortOrder]);

  return useStore(selector);
}

function useSortedSidebarThreadIdsByProject(input: {
  projectIds: readonly ProjectId[];
  sortOrder: SidebarThreadSortOrder;
}): Map<ProjectId, ThreadId[]> {
  const selector = useMemo(() => {
    let previousEntries: Array<readonly [ProjectId, ThreadId[]]> = [];
    let previousThreadIdsByProjectId = new Map<ProjectId, ThreadId[]>();

    return (state: AppState): Map<ProjectId, ThreadId[]> => {
      const nextEntries = input.projectIds.map((projectId) => {
        const nextThreadIds = sortThreadsForSidebar(
          state.threads.filter(
            (thread) => thread.projectId === projectId && thread.archivedAt === null,
          ),
          input.sortOrder,
        ).map((thread) => thread.id);
        const previousThreadIds = previousThreadIdsByProjectId.get(projectId);
        const stableThreadIds =
          previousThreadIds && areArraysShallowEqual(previousThreadIds, nextThreadIds)
            ? previousThreadIds
            : nextThreadIds;
        return [projectId, stableThreadIds] as const;
      });

      if (
        previousEntries.length === nextEntries.length &&
        previousEntries.every(
          ([previousProjectId, previousThreadIds], index) =>
            previousProjectId === nextEntries[index]?.[0] &&
            previousThreadIds === nextEntries[index]?.[1],
        )
      ) {
        return previousThreadIdsByProjectId;
      }

      previousEntries = nextEntries;
      previousThreadIdsByProjectId = new Map(nextEntries);
      return previousThreadIdsByProjectId;
    };
  }, [input.projectIds, input.sortOrder]);

  return useStore(selector);
}

function useThreadsForSidebarIds(threadIds: readonly ThreadId[]): Array<Thread | undefined> {
  const selector = useMemo(() => {
    let previousThreads: Array<Thread | undefined> = [];

    return (state: AppState): Array<Thread | undefined> => {
      const nextThreads = threadIds.map((threadId) =>
        state.threads.find((thread) => thread.id === threadId),
      );
      if (areArraysShallowEqual(previousThreads, nextThreads)) {
        return previousThreads;
      }
      previousThreads = nextThreads;
      return nextThreads;
    };
  }, [threadIds]);

  return useStore(selector);
}

function useSidebarThreadSnapshots(threadIds: readonly ThreadId[]): SidebarThreadSnapshot[] {
  const threads = useThreadsForSidebarIds(threadIds);
  const previousSnapshotsRef = useRef<SidebarThreadSnapshot[]>([]);
  const lastVisitedAtValues = useUiStateStore(
    useMemo(() => {
      let previousValues: Array<string | undefined> = [];

      return (store: { threadLastVisitedAtById: Record<string, string> }) => {
        const nextValues = threadIds.map((threadId) => store.threadLastVisitedAtById[threadId]);
        if (areArraysShallowEqual(previousValues, nextValues)) {
          return previousValues;
        }
        previousValues = nextValues;
        return nextValues;
      };
    }, [threadIds]),
  );

  return useMemo(() => {
    const nextSnapshots = threads.flatMap((thread, index) =>
      thread ? [toSidebarThreadSnapshot(thread, lastVisitedAtValues[index])] : [],
    );
    if (areArraysShallowEqual(previousSnapshotsRef.current, nextSnapshots)) {
      return previousSnapshotsRef.current;
    }
    previousSnapshotsRef.current = nextSnapshots;
    return nextSnapshots;
  }, [lastVisitedAtValues, threads]);
}

function useSidebarThreadGitTargets(threadIds: readonly ThreadId[]): SidebarThreadGitTarget[] {
  const selector = useMemo(() => {
    let previousTargets: SidebarThreadGitTarget[] = [];
    const cache = new Map<ThreadId, SidebarThreadGitTarget>();

    return (state: AppState): SidebarThreadGitTarget[] => {
      const nextTargets = threadIds.flatMap((threadId) => {
        const thread = state.threads.find((candidate) => candidate.id === threadId);
        if (!thread) {
          cache.delete(threadId);
          return [];
        }

        const cached = cache.get(threadId);
        if (
          cached &&
          cached.branch === thread.branch &&
          cached.projectId === thread.projectId &&
          cached.worktreePath === thread.worktreePath
        ) {
          return [cached];
        }

        const nextTarget: SidebarThreadGitTarget = {
          threadId,
          branch: thread.branch,
          projectId: thread.projectId,
          worktreePath: thread.worktreePath,
        };
        cache.set(threadId, nextTarget);
        return [nextTarget];
      });

      if (areArraysShallowEqual(previousTargets, nextTargets)) {
        return previousTargets;
      }

      previousTargets = nextTargets;
      return nextTargets;
    };
  }, [threadIds]);

  return useStore(selector);
}

function resolveHasActionableLatestProposedPlan(thread: Thread): boolean {
  if (thread.interactionMode !== "plan") {
    return false;
  }
  if (!isLatestTurnSettled(thread.latestTurn, thread.session)) {
    return false;
  }
  return hasActionableProposedPlan(
    findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
  );
}

function useSidebarThreadSnapshot(threadId: ThreadId): SidebarThreadSnapshot | undefined {
  const thread = useStore(
    useMemo(() => (state: AppState) => selectThreadById(threadId)(state), [threadId]),
  );
  const lastVisitedAt = useUiStateStore((store) => store.threadLastVisitedAtById[threadId]);

  return useMemo(
    () => (thread ? toSidebarThreadSnapshot(thread, lastVisitedAt) : undefined),
    [lastVisitedAt, thread],
  );
}

function toSidebarThreadSnapshot(
  thread: Thread,
  lastVisitedAt: string | undefined,
): SidebarThreadSnapshot {
  const latestUserMessageAt = thread.latestUserMessageAt ?? null;
  const latestTurnCompletedAt = thread.latestTurn?.completedAt ?? null;
  const pendingApprovalCount = thread.pendingApprovalCount ?? 0;
  const pendingUserInputCount = thread.pendingUserInputCount ?? 0;
  const hasActionableLatestProposedPlan = resolveHasActionableLatestProposedPlan(thread);
  const cached = sidebarThreadSnapshotCache.get(thread.id);
  if (
    cached &&
    cached.archivedAt === thread.archivedAt &&
    cached.branch === thread.branch &&
    cached.createdAt === thread.createdAt &&
    cached.hasActionableLatestProposedPlan === hasActionableLatestProposedPlan &&
    cached.interactionMode === thread.interactionMode &&
    cached.lastVisitedAt === lastVisitedAt &&
    cached.latestTurnCompletedAt === latestTurnCompletedAt &&
    cached.latestUserMessageAt === latestUserMessageAt &&
    cached.pendingApprovalCount === pendingApprovalCount &&
    cached.pendingUserInputCount === pendingUserInputCount &&
    cached.projectId === thread.projectId &&
    cached.session === thread.session &&
    cached.title === thread.title &&
    cached.worktreePath === thread.worktreePath
  ) {
    return cached.snapshot;
  }

  const snapshot: SidebarThreadSnapshot = {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    hasActionableLatestProposedPlan,
    lastVisitedAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurnCompletedAt,
    latestUserMessageAt,
    pendingApprovalCount,
    pendingUserInputCount,
  };
  sidebarThreadSnapshotCache.set(thread.id, {
    archivedAt: thread.archivedAt,
    branch: thread.branch,
    createdAt: thread.createdAt,
    hasActionableLatestProposedPlan,
    interactionMode: thread.interactionMode,
    lastVisitedAt,
    latestTurnCompletedAt,
    latestUserMessageAt,
    pendingApprovalCount,
    pendingUserInputCount,
    projectId: thread.projectId,
    session: thread.session,
    snapshot,
    title: thread.title,
    worktreePath: thread.worktreePath,
  });
  return snapshot;
}
interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function areThreadPrEqual(previous: ThreadPr, next: ThreadPr): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }
  return (
    previous.state === next.state &&
    previous.url === next.url &&
    previous.number === next.number &&
    previous.baseBranch === next.baseBranch &&
    previous.headBranch === next.headBranch &&
    previous.title === next.title
  );
}

function areSidebarThreadRowPropsEqual(
  previous: ComponentProps<typeof SidebarThreadRowInner>,
  next: ComponentProps<typeof SidebarThreadRowInner>,
): boolean {
  if (previous.threadId !== next.threadId) return false;
  if (previous.projectId !== next.projectId) return false;
  if (previous.routeThreadId !== next.routeThreadId) return false;
  if (previous.jumpLabel !== next.jumpLabel) return false;
  if (!areThreadPrEqual(previous.pr, next.pr)) return false;
  if (previous.showThreadJumpHints !== next.showThreadJumpHints) return false;
  if (previous.confirmThreadArchive !== next.confirmThreadArchive) return false;
  if (previous.renamingThreadId !== next.renamingThreadId) return false;
  if (
    previous.renamingThreadId === previous.threadId &&
    previous.renamingTitle !== next.renamingTitle
  ) {
    return false;
  }
  if (previous.confirmingArchiveThreadId !== next.confirmingArchiveThreadId) return false;
  return true;
}

function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: NonNullable<ReturnType<typeof resolveThreadStatusPill>>;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "animate-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

const SidebarWordmark = memo(function SidebarWordmark() {
  return (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1">
              <T3Wordmark />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                Code
              </span>
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL}
              </span>
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

const SidebarTopHeader = memo(function SidebarTopHeader(props: { isElectron: boolean }) {
  return props.isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
      <SidebarWordmark />
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
      <SidebarWordmark />
    </SidebarHeader>
  );
});

const SidebarSettingsFooter = memo(function SidebarSettingsFooter(props: {
  onOpenSettings: () => void;
}) {
  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={props.onOpenSettings}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

interface RenderedSidebarProject {
  hasHiddenThreads: boolean;
  hiddenThreadIds: readonly ThreadId[];
  orderedProjectThreadIds: readonly ThreadId[];
  projectExpanded: boolean;
  projectId: ProjectId;
  renderedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
}

function SidebarThreadRowInner({
  threadId,
  projectId,
  routeThreadId,
  jumpLabel,
  pr,
  showThreadJumpHints,
  confirmThreadArchive,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  renamingInputRef,
  renamingCommittedRef,
  cancelRename,
  commitRename,
  confirmingArchiveThreadId,
  setConfirmingArchiveThreadId,
  confirmArchiveButtonRefs,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  clearSelection,
  handleThreadContextMenu,
  attemptArchiveThread,
  openPrLink,
}: {
  threadId: ThreadId;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
  jumpLabel: string | null;
  pr: ThreadPr;
  showThreadJumpHints: boolean;
  confirmThreadArchive: boolean;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  cancelRename: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: (
    threadId: ThreadId | null | ((current: ThreadId | null) => ThreadId | null),
  ) => void;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  handleThreadClick: (event: MouseEvent, threadId: ThreadId, projectId: ProjectId) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  clearSelection: () => void;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}) {
  const thread = useSidebarThreadSnapshot(threadId);
  const isSelected = useThreadSelectionStore((store) => store.selectedThreadIds.has(threadId));
  const hasAnySelection = useThreadSelectionStore((store) => store.selectedThreadIds.size > 0);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, threadId).runningTerminalIds,
  );
  if (!thread) {
    return null;
  }
  const isActive = routeThreadId === thread.id;
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const isConfirmingArchive = confirmingArchiveThreadId === thread.id && !isThreadRunning;
  const threadStatus = useMemo(
    () =>
      resolveThreadStatusPill({
        thread,
        hasPendingApprovals: thread.pendingApprovalCount > 0,
        hasPendingUserInput: thread.pendingUserInputCount > 0,
      }),
    [thread],
  );
  const prStatus = prStatusIndicator(pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={() => {
        setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
      }}
      onBlurCapture={(event) => {
        const currentTarget = event.currentTarget;
        requestAnimationFrame(() => {
          if (currentTarget.contains(document.activeElement)) {
            return;
          }
          setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
        });
      }}
    >
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate`}
        onClick={(event) => {
          handleThreadClick(event, thread.id, projectId);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          navigateToThread(thread.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (hasAnySelection && isSelected) {
            void handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (hasAnySelection) {
              clearSelection();
            }
            void handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={(event) => {
                      openPrLink(event, prStatus.url);
                    }}
                  >
                    <GitPullRequestIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          ) : null}
          {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
          {renamingThreadId === thread.id ? (
            <input
              ref={(element) => {
                if (element && renamingInputRef.current !== element) {
                  renamingInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
              value={renamingTitle}
              onChange={(event) => setRenamingTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  renamingCommittedRef.current = true;
                  void commitRename(thread.id, renamingTitle, thread.title);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  renamingCommittedRef.current = true;
                  cancelRename();
                }
              }}
              onBlur={() => {
                if (!renamingCommittedRef.current) {
                  void commitRename(thread.id, renamingTitle, thread.title);
                }
              }}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus ? (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
            </span>
          ) : null}
          <div className="flex min-w-12 justify-end">
            {isConfirmingArchive ? (
              <button
                ref={(element) => {
                  if (element) {
                    confirmArchiveButtonRefs.current.set(thread.id, element);
                  } else {
                    confirmArchiveButtonRefs.current.delete(thread.id);
                  }
                }}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute right-1 top-1/2 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setConfirmingArchiveThreadId((current) =>
                    current === thread.id ? null : current,
                  );
                  void attemptArchiveThread(thread.id);
                }}
              >
                Confirm
              </button>
            ) : !isThreadRunning ? (
              confirmThreadArchive ? (
                <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setConfirmingArchiveThreadId(thread.id);
                      requestAnimationFrame(() => {
                        confirmArchiveButtonRefs.current.get(thread.id)?.focus();
                      });
                    }}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void attemptArchiveThread(thread.id);
                          }}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span className={threadMetaClassName}>
              {showThreadJumpHints && jumpLabel ? (
                <span
                  className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                  title={jumpLabel}
                >
                  {jumpLabel}
                </span>
              ) : (
                <span
                  className={`text-[10px] ${
                    isHighlighted
                      ? "text-foreground/72 dark:text-foreground/82"
                      : "text-muted-foreground/40"
                  }`}
                >
                  {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.createdAt)}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

const SidebarThreadRow = memo(SidebarThreadRowInner, areSidebarThreadRowPropsEqual);

const SidebarProjectSection = memo(function SidebarProjectSection({
  renderedProject,
  dragHandleProps,
  isManualProjectSorting,
  handleProjectTitlePointerDownCapture,
  handleProjectTitleClick,
  handleProjectTitleKeyDown,
  handleProjectContextMenu,
  suppressProjectClickForContextMenuRef,
  handleNewThread,
  defaultThreadEnvMode,
  newThreadShortcutLabel,
  attachThreadListAutoAnimateRef,
  routeThreadId,
  threadJumpLabelById,
  prByThreadId,
  showThreadJumpHints,
  confirmThreadArchive,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  renamingInputRef,
  renamingCommittedRef,
  cancelRename,
  commitRename,
  confirmingArchiveThreadId,
  setConfirmingArchiveThreadId,
  confirmArchiveButtonRefs,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  clearSelection,
  handleThreadContextMenu,
  attemptArchiveThread,
  openPrLink,
  expandThreadListForProject,
  collapseThreadListForProject,
}: {
  renderedProject: RenderedSidebarProject;
  dragHandleProps: SortableProjectHandleProps | null;
  isManualProjectSorting: boolean;
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (
    event: React.MouseEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectTitleKeyDown: (
    event: React.KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectContextMenu: (
    projectId: ProjectId,
    position: { x: number; y: number },
  ) => Promise<void>;
  suppressProjectClickForContextMenuRef: MutableRefObject<boolean>;
  handleNewThread: (
    projectId: ProjectId,
    options?: { envMode?: "local" | "worktree" },
  ) => Promise<void>;
  defaultThreadEnvMode: "local" | "worktree";
  newThreadShortcutLabel: string | null | undefined;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  routeThreadId: ThreadId | null;
  threadJumpLabelById: ReadonlyMap<ThreadId, string>;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr>;
  showThreadJumpHints: boolean;
  confirmThreadArchive: boolean;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  cancelRename: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: (
    threadId: ThreadId | null | ((current: ThreadId | null) => ThreadId | null),
  ) => void;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  handleThreadClick: (event: MouseEvent, threadId: ThreadId, projectId: ProjectId) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  clearSelection: () => void;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
}) {
  const project = useProjectById(renderedProject.projectId);
  const projectThreads = useSidebarThreadSnapshots(renderedProject.orderedProjectThreadIds);

  const threadStatuses = useMemo(
    () =>
      new Map(
        projectThreads.map((thread) => [
          thread.id,
          resolveThreadStatusPill({
            thread,
            hasPendingApprovals: thread.pendingApprovalCount > 0,
            hasPendingUserInput: thread.pendingUserInputCount > 0,
          }),
        ]),
      ),
    [projectThreads],
  );
  const projectStatus = useMemo(
    () =>
      resolveProjectStatusIndicator(
        projectThreads.map((thread) => threadStatuses.get(thread.id) ?? null),
      ),
    [projectThreads, threadStatuses],
  );
  const hiddenThreadStatus = useMemo(
    () =>
      resolveProjectStatusIndicator(
        renderedProject.hiddenThreadIds.map((threadId) => threadStatuses.get(threadId) ?? null),
      ),
    [renderedProject.hiddenThreadIds, threadStatuses],
  );
  const projectThreadIdSet = useMemo(
    () => new Set(projectThreads.map((thread) => thread.id)),
    [projectThreads],
  );
  const renderedThreads = useMemo(
    () => renderedProject.renderedThreadIds.filter((threadId) => projectThreadIdSet.has(threadId)),
    [projectThreadIdSet, renderedProject.renderedThreadIds],
  );

  if (!project) {
    return null;
  }

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          }`}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectTitlePointerDownCapture}
          onClick={(event) => handleProjectTitleClick(event, project.id)}
          onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            suppressProjectClickForContextMenuRef.current = true;
            void handleProjectContextMenu(project.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          {!renderedProject.projectExpanded && projectStatus ? (
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                <span
                  className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                    projectStatus.pulse ? "animate-pulse" : ""
                  }`}
                />
              </span>
              <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
            </span>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                renderedProject.projectExpanded ? "rotate-90" : ""
              }`}
            />
          )}
          <ProjectFavicon cwd={project.cwd} />
          <span className="flex-1 truncate text-xs font-medium text-foreground/90">
            {project.name}
          </span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.name}`}
                    data-testid="new-thread-button"
                  />
                }
                showOnHover
                className="right-1.5 top-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleNewThread(project.id, {
                    envMode: resolveSidebarNewThreadEnvMode({
                      defaultEnvMode: defaultThreadEnvMode,
                    }),
                  });
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarMenuSub
        ref={attachThreadListAutoAnimateRef}
        className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
      >
        {renderedProject.shouldShowThreadPanel && renderedProject.showEmptyThreadState ? (
          <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
            <div
              data-thread-selection-safe
              className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
            >
              <span>No threads yet</span>
            </div>
          </SidebarMenuSubItem>
        ) : null}
        {renderedProject.shouldShowThreadPanel &&
          renderedThreads.map((threadId) => (
            <SidebarThreadRow
              key={threadId}
              threadId={threadId}
              projectId={renderedProject.projectId}
              routeThreadId={routeThreadId}
              jumpLabel={threadJumpLabelById.get(threadId) ?? null}
              pr={prByThreadId.get(threadId) ?? null}
              showThreadJumpHints={showThreadJumpHints}
              confirmThreadArchive={confirmThreadArchive}
              renamingThreadId={renamingThreadId}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              renamingInputRef={renamingInputRef}
              renamingCommittedRef={renamingCommittedRef}
              cancelRename={cancelRename}
              commitRename={commitRename}
              confirmingArchiveThreadId={confirmingArchiveThreadId}
              setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              clearSelection={clearSelection}
              handleThreadContextMenu={handleThreadContextMenu}
              attemptArchiveThread={attemptArchiveThread}
              openPrLink={openPrLink}
            />
          ))}

        {renderedProject.projectExpanded &&
        renderedProject.hasHiddenThreads &&
        !renderedProject.isThreadListExpanded ? (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                expandThreadListForProject(project.id);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {hiddenThreadStatus ? (
                  <ThreadStatusLabel status={hiddenThreadStatus} compact />
                ) : null}
                <span>Show more</span>
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ) : null}
        {renderedProject.projectExpanded &&
        renderedProject.hasHiddenThreads &&
        renderedProject.isThreadListExpanded ? (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                collapseThreadListForProject(project.id);
              }}
            >
              <span>Show less</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ) : null}
      </SidebarMenuSub>
    </>
  );
});

const Sidebar = memo(function Sidebar() {
  const projects = useStore((store) => store.projects);
  const { projectExpandedById, projectOrder } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
    })),
  );
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread } = useHandleNewThread();
  const { archiveThread, deleteThread } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const keybindings = useServerKeybindings();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadId, setConfirmingArchiveThreadId] = useState<ThreadId | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<ThreadId, HTMLButtonElement>());
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const sortedProjectIds = useSortedSidebarProjectIds({
    projectOrder,
    sortOrder: appSettings.sidebarProjectSortOrder,
  });
  const projectThreadIdsByProjectId = useSortedSidebarThreadIdsByProject({
    projectIds: sortedProjectIds,
    sortOrder: appSettings.sidebarThreadSortOrder,
  });
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const routeTerminalOpen = useTerminalStateStore(
    useMemo(
      () => (state) =>
        routeThreadId
          ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
          : false,
      [routeThreadId],
    ),
  );
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );
  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await archiveThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveThread],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThreadId = projectThreadIdsByProjectId.get(projectId)?.[0];
      if (!latestThreadId) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThreadId },
      });
    },
    [navigate, projectThreadIdsByProjectId],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      appSettings.defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = useStore.getState().threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadId);
    },
    [
      appSettings.confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      projectCwdById,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const thread = useStore.getState().threads.find((candidate) => candidate.id === id);
          markThreadUnread(id, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, projectId: ProjectId) => {
      const orderedProjectThreadIds =
        projectThreadIdsByProjectId.get(projectId) ?? EMPTY_THREAD_IDS;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      projectThreadIdsByProjectId,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearSelection, navigate, selectedThreadIds.size, setSelectionAnchor],
  );
  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "copy-path", label: "Copy Project Path" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd, { path: project.cwd });
        return;
      }
      if (clicked !== "delete") return;

      const projectThreadIds = projectThreadIdsByProjectId.get(projectId) ?? EMPTY_THREAD_IDS;
      if (projectThreadIds.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before removing it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
      if (!confirmed) return;

      try {
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      copyPathToClipboard,
      getDraftThreadByProjectId,
      projects,
      projectThreadIdsByProjectId,
    ],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderProjects(
        ProjectId.makeUnsafe(String(active.id)),
        ProjectId.makeUnsafe(String(over.id)),
      );
    },
    [appSettings.sidebarProjectSortOrder, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        // Keep context-menu gestures from arming the sortable drag sensor.
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [],
  );

  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const renderedProjects = useMemo(
    () =>
      sortedProjectIds.map((projectId) => {
        const projectExpanded = projectExpandedById[projectId] ?? true;
        const orderedProjectThreadIds =
          projectThreadIdsByProjectId.get(projectId) ?? EMPTY_THREAD_IDS;
        const activeThreadId = routeThreadId ?? undefined;
        const isThreadListExpanded = expandedThreadListsByProject.has(projectId);
        const pinnedCollapsedThreadId =
          !projectExpanded && activeThreadId && orderedProjectThreadIds.includes(activeThreadId)
            ? activeThreadId
            : null;
        const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThreadId !== null;
        const {
          hasHiddenThreads,
          hiddenThreads: hiddenProjectThreads,
          visibleThreads: visibleProjectThreads,
        } = getVisibleThreadsForProject({
          threads: orderedProjectThreadIds.map((threadId) => ({ id: threadId })),
          activeThreadId,
          isThreadListExpanded,
          previewLimit: THREAD_PREVIEW_LIMIT,
        });
        const hiddenThreadIds = hiddenProjectThreads.map((thread) => thread.id);
        const renderedThreadIds = pinnedCollapsedThreadId
          ? [pinnedCollapsedThreadId]
          : visibleProjectThreads.map((thread) => thread.id);
        const showEmptyThreadState = projectExpanded && orderedProjectThreadIds.length === 0;

        return {
          hasHiddenThreads,
          hiddenThreadIds,
          orderedProjectThreadIds,
          projectExpanded,
          projectId,
          renderedThreadIds,
          showEmptyThreadState,
          shouldShowThreadPanel,
          isThreadListExpanded,
        };
      }),
    [
      expandedThreadListsByProject,
      projectExpandedById,
      projectThreadIdsByProjectId,
      routeThreadId,
      sortedProjectIds,
    ],
  );
  const visibleSidebarThreadIds = useMemo(
    () =>
      renderedProjects.flatMap((renderedProject) =>
        renderedProject.shouldShowThreadPanel ? renderedProject.renderedThreadIds : [],
      ),
    [renderedProjects],
  );
  const threadJumpCommandById = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandById.keys()],
    [threadJumpCommandById],
  );
  const threadJumpLabelById = useMemo(() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  }, [keybindings, sidebarShortcutLabelOptions, threadJumpCommandById]);
  const orderedSidebarThreadIds = visibleSidebarThreadIds;
  const visibleSidebarThreadGitTargets = useSidebarThreadGitTargets(visibleSidebarThreadIds);
  const threadGitTargets = useMemo(
    () =>
      visibleSidebarThreadGitTargets.map((thread) => ({
        threadId: thread.threadId,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, visibleSidebarThreadGitTargets],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const onWindowKeyDown = (event: KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadId = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadIds,
          currentThreadId: routeThreadId,
          direction: traversalDirection,
        });
        if (!targetThreadId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(targetThreadId);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = threadJumpThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThreadId);
    };

    const onWindowKeyUp = (event: KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );
    };

    const onWindowBlur = () => {
      updateThreadJumpHintsVisibility(false);
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
    keybindings,
    navigateToThread,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
    threadJumpThreadIds,
    updateThreadJumpHintsVisibility,
  ]);

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const renderProjectItem = useCallback(
    (
      renderedProject: RenderedSidebarProject,
      dragHandleProps: SortableProjectHandleProps | null,
    ) => (
      <SidebarProjectSection
        renderedProject={renderedProject}
        dragHandleProps={dragHandleProps}
        isManualProjectSorting={isManualProjectSorting}
        handleProjectTitlePointerDownCapture={handleProjectTitlePointerDownCapture}
        handleProjectTitleClick={handleProjectTitleClick}
        handleProjectTitleKeyDown={handleProjectTitleKeyDown}
        handleProjectContextMenu={handleProjectContextMenu}
        suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
        handleNewThread={handleNewThread}
        defaultThreadEnvMode={appSettings.defaultThreadEnvMode}
        newThreadShortcutLabel={newThreadShortcutLabel}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        routeThreadId={routeThreadId}
        threadJumpLabelById={threadJumpLabelById}
        prByThreadId={prByThreadId}
        showThreadJumpHints={showThreadJumpHints}
        confirmThreadArchive={appSettings.confirmThreadArchive}
        renamingThreadId={renamingThreadId}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        cancelRename={cancelRename}
        commitRename={commitRename}
        confirmingArchiveThreadId={confirmingArchiveThreadId}
        setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        clearSelection={clearSelection}
        handleThreadContextMenu={handleThreadContextMenu}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />
    ),
    [
      appSettings.confirmThreadArchive,
      appSettings.defaultThreadEnvMode,
      attachThreadListAutoAnimateRef,
      attemptArchiveThread,
      cancelRename,
      clearSelection,
      collapseThreadListForProject,
      commitRename,
      confirmingArchiveThreadId,
      expandThreadListForProject,
      handleMultiSelectContextMenu,
      handleNewThread,
      handleProjectContextMenu,
      handleProjectTitleClick,
      handleProjectTitleKeyDown,
      handleProjectTitlePointerDownCapture,
      handleThreadClick,
      handleThreadContextMenu,
      isManualProjectSorting,
      navigateToThread,
      newThreadShortcutLabel,
      openPrLink,
      prByThreadId,
      renamingThreadId,
      renamingTitle,
      routeThreadId,
      showThreadJumpHints,
      threadJumpLabelById,
    ],
  );

  return (
    <>
      <SidebarTopHeader isElectron={isElectron} />

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarContent className="gap-0">
            {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
              <SidebarGroup className="px-2 pt-2 pb-0">
                <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
                  <TriangleAlertIcon />
                  <AlertTitle>Intel build on Apple Silicon</AlertTitle>
                  <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
                  {desktopUpdateButtonAction !== "none" ? (
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={desktopUpdateButtonDisabled}
                        onClick={handleDesktopUpdateButtonClick}
                      >
                        {desktopUpdateButtonAction === "download"
                          ? "Download ARM build"
                          : "Install ARM build"}
                      </Button>
                    </AlertAction>
                  ) : null}
                </Alert>
              </SidebarGroup>
            ) : null}
            <SidebarGroup className="px-2 py-2">
              <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Projects
                </span>
                <div className="flex items-center gap-1">
                  <ProjectSortMenu
                    projectSortOrder={appSettings.sidebarProjectSortOrder}
                    threadSortOrder={appSettings.sidebarThreadSortOrder}
                    onProjectSortOrderChange={(sortOrder) => {
                      updateSettings({ sidebarProjectSortOrder: sortOrder });
                    }}
                    onThreadSortOrderChange={(sortOrder) => {
                      updateSettings({ sidebarThreadSortOrder: sortOrder });
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={
                            shouldShowProjectPathEntry ? "Cancel add project" : "Add project"
                          }
                          aria-pressed={shouldShowProjectPathEntry}
                          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                          onClick={handleStartAddProject}
                        />
                      }
                    >
                      <PlusIcon
                        className={`size-3.5 transition-transform duration-150 ${
                          shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                        }`}
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="right">
                      {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              </div>
              {shouldShowProjectPathEntry && (
                <div className="mb-2 px-1">
                  {isElectron && (
                    <button
                      type="button"
                      className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => void handlePickFolder()}
                      disabled={isPickingFolder || isAddingProject}
                    >
                      <FolderIcon className="size-3.5" />
                      {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                    </button>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      ref={addProjectInputRef}
                      className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                        addProjectError
                          ? "border-red-500/70 focus:border-red-500"
                          : "border-border focus:border-ring"
                      }`}
                      placeholder="/path/to/project"
                      value={newCwd}
                      onChange={(event) => {
                        setNewCwd(event.target.value);
                        setAddProjectError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleAddProject();
                        if (event.key === "Escape") {
                          setAddingProject(false);
                          setAddProjectError(null);
                        }
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                      onClick={handleAddProject}
                      disabled={!canAddProject}
                    >
                      {isAddingProject ? "Adding..." : "Add"}
                    </button>
                  </div>
                  {addProjectError && (
                    <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                      {addProjectError}
                    </p>
                  )}
                </div>
              )}

              {isManualProjectSorting ? (
                <DndContext
                  sensors={projectDnDSensors}
                  collisionDetection={projectCollisionDetection}
                  modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                  onDragStart={handleProjectDragStart}
                  onDragEnd={handleProjectDragEnd}
                  onDragCancel={handleProjectDragCancel}
                >
                  <SidebarMenu>
                    <SortableContext
                      items={renderedProjects.map((renderedProject) => renderedProject.projectId)}
                      strategy={verticalListSortingStrategy}
                    >
                      {renderedProjects.map((renderedProject) => (
                        <SortableProjectItem
                          key={renderedProject.projectId}
                          projectId={renderedProject.projectId}
                        >
                          {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                        </SortableProjectItem>
                      ))}
                    </SortableContext>
                  </SidebarMenu>
                </DndContext>
              ) : (
                <SidebarMenu ref={attachProjectListAutoAnimateRef}>
                  {renderedProjects.map((renderedProject) => (
                    <SidebarMenuItem key={renderedProject.projectId} className="rounded-md">
                      {renderProjectItem(renderedProject, null)}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}

              {projects.length === 0 && !shouldShowProjectPathEntry && (
                <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
                  No projects yet
                </div>
              )}
            </SidebarGroup>
          </SidebarContent>

          <SidebarSeparator />
          <SidebarSettingsFooter onOpenSettings={handleOpenSettings} />
        </>
      )}
    </>
  );
});

export default Sidebar;
