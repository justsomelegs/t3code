import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type TurnId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  hasToolActivityForTurn,
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
import {
  createThreadActivitiesSelectorByRef,
  createThreadMessagesSelectorByRef,
  createThreadProposedPlansSelectorByRef,
  createThreadTurnDiffSummariesSelectorByRef,
} from "../../storeSelectors";
import { useStore } from "../../store";
import { useUiStateStore } from "../../uiStateStore";

const EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID: Record<string, boolean> = {};

interface MessagesTimelineContainerProps {
  activeLatestTurn: Thread["latestTurn"] | null;
  activeTurnId: TurnId | null;
  activeTurnInProgress: boolean;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadSession: Thread["session"] | null;
  draftActivities: Thread["activities"];
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  latestTurnSettled: boolean;
  localDispatchStartedAt: string | null;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRevertToTurnCount: (turnCount: number) => void;
  phase: SessionPhase;
  resolvedTheme: "light" | "dark";
  scheduleStickToBottom: () => void;
  scrollContainer: HTMLDivElement | null;
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  timestampFormat: TimestampFormat;
  threadRef: ScopedThreadRef | null;
  draftMessages: ChatMessage[];
  draftProposedPlans: Thread["proposedPlans"];
  draftTurnDiffSummaries: Thread["turnDiffSummaries"];
  optimisticUserMessages: ChatMessage[];
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  clearAttachmentPreviewHandoff: (
    messageId: MessageId,
    previewUrls?: ReadonlyArray<string>,
  ) => void;
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
    draftActivities,
    isRevertingCheckpoint,
    isWorking,
    latestTurnSettled,
    localDispatchStartedAt,
    markdownCwd,
    onImageExpand,
    onOpenTurnDiff,
    onRevertToTurnCount,
    phase,
    resolvedTheme,
    scheduleStickToBottom,
    scrollContainer,
    shouldAutoScrollRef,
    timestampFormat,
    threadRef,
    draftMessages,
    draftProposedPlans,
    draftTurnDiffSummaries,
    optimisticUserMessages,
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoff,
    workspaceRoot,
  } = props;
  const serverActivities = useStore(
    useMemo(() => createThreadActivitiesSelectorByRef(threadRef), [threadRef]),
  );
  const serverMessages = useStore(
    useMemo(() => createThreadMessagesSelectorByRef(threadRef), [threadRef]),
  );
  const serverProposedPlans = useStore(
    useMemo(() => createThreadProposedPlansSelectorByRef(threadRef), [threadRef]),
  );
  const serverTurnDiffSummaries = useStore(
    useMemo(() => createThreadTurnDiffSummariesSelectorByRef(threadRef), [threadRef]),
  );
  const changedFilesExpandedByTurnId = useUiStateStore((store) =>
    threadRef
      ? (store.threadChangedFilesExpandedById[scopedThreadKey(threadRef)] ??
        EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID)
      : EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID,
  );
  const setThreadChangedFilesExpanded = useUiStateStore(
    (store) => store.setThreadChangedFilesExpanded,
  );
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const timelineMessages = useMemo(() => {
    const messages = threadRef ? serverMessages : draftMessages;
    let messagesWithPreviewHandoff = messages;
    if (Object.keys(attachmentPreviewHandoffByMessageId).length > 0) {
      let nextMessages: ChatMessage[] | null = null;

      for (const [messageIndex, message] of messages.entries()) {
        if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
          if (nextMessages) {
            nextMessages.push(message);
          }
          continue;
        }

        const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
        if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
          if (nextMessages) {
            nextMessages.push(message);
          }
          continue;
        }

        let changed = false;
        let imageIndex = 0;
        const attachments = [...message.attachments];

        for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
          const attachment = attachments[attachmentIndex];
          if (!attachment || attachment.type !== "image") {
            continue;
          }

          const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
          imageIndex += 1;
          if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
            continue;
          }

          changed = true;
          attachments[attachmentIndex] = {
            ...attachment,
            previewUrl: handoffPreviewUrl,
          };
        }

        if (!changed) {
          if (nextMessages) {
            nextMessages.push(message);
          }
          continue;
        }

        if (!nextMessages) {
          nextMessages = messages.slice(0, messageIndex);
        }

        nextMessages.push({
          ...message,
          attachments,
        });
      }

      messagesWithPreviewHandoff = nextMessages ?? messages;
    }

    if (optimisticUserMessages.length === 0) {
      return messagesWithPreviewHandoff;
    }
    const serverIds = new Set(messagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return messagesWithPreviewHandoff;
    }
    return [...messagesWithPreviewHandoff, ...pendingMessages];
  }, [
    attachmentPreviewHandoffByMessageId,
    draftMessages,
    optimisticUserMessages,
    serverMessages,
    threadRef,
  ]);
  const proposedPlans = threadRef ? serverProposedPlans : draftProposedPlans;
  const turnDiffSummaries = threadRef ? serverTurnDiffSummaries : draftTurnDiffSummaries;
  const threadActivities = threadRef ? serverActivities : draftActivities;
  const activeWorkStartedAt = useMemo(
    () => deriveActiveWorkStartedAt(activeLatestTurn, activeThreadSession, localDispatchStartedAt),
    [activeLatestTurn, activeThreadSession, localDispatchStartedAt],
  );
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
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
  const onSetChangedFilesExpanded = useCallback(
    (turnId: TurnId, expanded: boolean) => {
      if (!threadRef) {
        return;
      }
      setThreadChangedFilesExpanded(scopedThreadKey(threadRef), turnId, expanded);
    },
    [setThreadChangedFilesExpanded, threadRef],
  );
  const activeThreadIdRef = useRef(activeThreadId);

  useEffect(() => {
    if (!threadRef || typeof Image === "undefined" || serverMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      const serverMessage = serverMessages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => undefined);

      cleanups.push(() => {
        cancelled = true;
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoff,
    serverMessages,
    threadRef,
  ]);

  useEffect(() => {
    if (activeThreadIdRef.current === activeThreadId) {
      return;
    }
    activeThreadIdRef.current = activeThreadId;
    setExpandedWorkGroups({});
  }, [activeThreadId]);

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
