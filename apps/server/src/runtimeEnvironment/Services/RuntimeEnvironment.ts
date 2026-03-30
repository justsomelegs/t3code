import type { ServerExecutionEnvironment, ServerHostRuntime } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ServerRuntimeEnvironmentDetails } from "../../runtimeEnvironment";

export interface RuntimeEnvironmentShape {
  readonly getRuntimeEnvironment: Effect.Effect<ServerRuntimeEnvironmentDetails>;
  readonly getHostRuntime: Effect.Effect<ServerHostRuntime>;
  readonly getAvailableExecutionEnvironments: Effect.Effect<
    ReadonlyArray<ServerExecutionEnvironment>
  >;
}

export class RuntimeEnvironment extends ServiceMap.Service<
  RuntimeEnvironment,
  RuntimeEnvironmentShape
>()("t3/runtimeEnvironment/Services/RuntimeEnvironment") {}
