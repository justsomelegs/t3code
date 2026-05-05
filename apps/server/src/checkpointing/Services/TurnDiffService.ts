import type {
  OrchestrationGetTurnDiffViewInput,
  OrchestrationGetTurnDiffViewResult,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { CheckpointServiceError } from "../Errors.ts";

export interface TurnDiffServiceShape {
  readonly getTurnDiffView: (
    input: OrchestrationGetTurnDiffViewInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffViewResult, CheckpointServiceError>;
}

export class TurnDiffService extends Context.Service<TurnDiffService, TurnDiffServiceShape>()(
  "t3/checkpointing/Services/TurnDiffService",
) {}
