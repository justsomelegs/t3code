import { type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import {
  applyOrchestrationEventsWithOutcome,
  type AppState,
  type OrchestrationEventApplyOutcome,
} from "./store";

export interface OrchestrationEventBatchApplyResult extends OrchestrationEventApplyOutcome {
  applied: boolean;
  latestSequence: number;
  liveServerThreadIds: ReadonlySet<ThreadId>;
  threadLifecycleChanged: boolean;
}

function collectLiveServerThreadIds(state: AppState): ReadonlySet<ThreadId> {
  return new Set(state.threads.map((thread) => thread.id));
}

export function applyOrchestrationEventBatch(input: {
  state: AppState;
  latestSequence: number;
  events: ReadonlyArray<OrchestrationEvent>;
}): OrchestrationEventBatchApplyResult {
  const unseenEvents = input.events.filter((event) => event.sequence > input.latestSequence);
  if (unseenEvents.length === 0) {
    return {
      applied: true,
      state: input.state,
      latestSequence: input.latestSequence,
      invalidateProviders: false,
      invalidateProjects: false,
      liveServerThreadIds: collectLiveServerThreadIds(input.state),
      threadLifecycleChanged: false,
    };
  }

  const firstEvent = unseenEvents[0];
  if (!firstEvent || firstEvent.sequence !== input.latestSequence + 1) {
    return {
      applied: false,
      state: input.state,
      latestSequence: input.latestSequence,
      invalidateProviders: false,
      invalidateProjects: false,
      liveServerThreadIds: collectLiveServerThreadIds(input.state),
      threadLifecycleChanged: false,
    };
  }

  for (let index = 1; index < unseenEvents.length; index += 1) {
    const previousEvent = unseenEvents[index - 1];
    const currentEvent = unseenEvents[index];
    if (!previousEvent || !currentEvent || currentEvent.sequence !== previousEvent.sequence + 1) {
      return {
        applied: false,
        state: input.state,
        latestSequence: input.latestSequence,
        invalidateProviders: false,
        invalidateProjects: false,
        liveServerThreadIds: collectLiveServerThreadIds(input.state),
        threadLifecycleChanged: false,
      };
    }
  }

  const outcome = applyOrchestrationEventsWithOutcome(input.state, unseenEvents);
  return {
    applied: true,
    ...outcome,
    latestSequence: unseenEvents.at(-1)?.sequence ?? input.latestSequence,
    liveServerThreadIds: collectLiveServerThreadIds(outcome.state),
    threadLifecycleChanged: unseenEvents.some(
      (event) => event.type === "thread.created" || event.type === "thread.deleted",
    ),
  };
}
