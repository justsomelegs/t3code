import { type EnvironmentId, type MessageId, type TurnId, type ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  inferCheckpointTurnCountByTurnId,
} from "../../session-logic";
import {
  type SessionPhase,
  type ChatMessage,
  type Thread,
  type TurnDiffSummary,
} from "../../types";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { MessagesTimeline } from "./MessagesTimeline";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";

type WorkLogEntries = ReturnType<typeof deriveWorkLogEntries>;

interface MessagesTimelineContainerProps {
  activeLatestTurn: Thread["latestTurn"] | null;
  activeTurnId: TurnId | null;
  activeTurnInProgress: boolean;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadSession: Thread["session"] | null;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  latestTurnHasToolActivity: boolean;
  latestTurnSettled: boolean;
  localDispatchStartedAt: string | null;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRevertToTurnCount: (turnCount: number) => void;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  phase: SessionPhase;
  proposedPlans: Thread["proposedPlans"];
  resolvedTheme: "light" | "dark";
  scheduleStickToBottom: () => void;
  scrollContainer: HTMLDivElement | null;
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  timelineMessages: ChatMessage[];
  timestampFormat: TimestampFormat;
  turnDiffSummaries: Thread["turnDiffSummaries"];
  workLogEntries: WorkLogEntries;
  workspaceRoot: string | undefined;
}

export const MessagesTimelineContainer = memo(function MessagesTimelineContainer(
  props: MessagesTimelineContainerProps,
) {
  const {
    activeLatestTurn,
    activeTurnId,
    activeTurnInProgress,
    activeThreadEnvironmentId,
    activeThreadId,
    activeThreadSession,
    changedFilesExpandedByTurnId,
    isRevertingCheckpoint,
    isWorking,
    latestTurnHasToolActivity,
    latestTurnSettled,
    localDispatchStartedAt,
    markdownCwd,
    onImageExpand,
    onOpenTurnDiff,
    onRevertToTurnCount,
    onSetChangedFilesExpanded,
    phase,
    proposedPlans,
    resolvedTheme,
    scheduleStickToBottom,
    scrollContainer,
    shouldAutoScrollRef,
    timelineMessages,
    timestampFormat,
    turnDiffSummaries,
    workLogEntries,
    workspaceRoot,
  } = props;
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const nowIso = useMemo(() => new Date(nowTick).toISOString(), [nowTick]);
  const activeWorkStartedAt = useMemo(
    () => deriveActiveWorkStartedAt(activeLatestTurn, activeThreadSession, localDispatchStartedAt),
    [activeLatestTurn, activeThreadSession, localDispatchStartedAt],
  );
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, proposedPlans, workLogEntries),
    [proposedPlans, timelineMessages, workLogEntries],
  );
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) {
        continue;
      }
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);
  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const messageCount = timelineMessages.length;
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );
  const activeThreadIdRef = useRef(activeThreadId);

  useEffect(() => {
    if (activeThreadIdRef.current === activeThreadId) {
      return;
    }
    activeThreadIdRef.current = activeThreadId;
    setExpandedWorkGroups({});
  }, [activeThreadId]);

  useEffect(() => {
    if (phase !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom, shouldAutoScrollRef]);

  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [phase, scheduleStickToBottom, shouldAutoScrollRef, timelineEntries]);

  return (
    <MessagesTimeline
      key={activeThreadId}
      hasMessages={timelineEntries.length > 0}
      isWorking={isWorking}
      activeTurnInProgress={activeTurnInProgress}
      activeTurnId={activeTurnId}
      activeTurnStartedAt={activeWorkStartedAt}
      scrollContainer={scrollContainer}
      timelineEntries={timelineEntries}
      completionDividerBeforeEntryId={completionDividerBeforeEntryId}
      completionSummary={completionSummary}
      turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
      nowIso={nowIso}
      activeThreadEnvironmentId={activeThreadEnvironmentId}
      expandedWorkGroups={expandedWorkGroups}
      onToggleWorkGroup={onToggleWorkGroup}
      changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
      onSetChangedFilesExpanded={onSetChangedFilesExpanded}
      onOpenTurnDiff={onOpenTurnDiff}
      revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
      onRevertUserMessage={onRevertUserMessage}
      isRevertingCheckpoint={isRevertingCheckpoint}
      onImageExpand={onImageExpand}
      markdownCwd={markdownCwd}
      resolvedTheme={resolvedTheme}
      timestampFormat={timestampFormat}
      workspaceRoot={workspaceRoot}
    />
  );
});
