import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  readonly bytes: number;
  readonly truncated: boolean;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";
  const truncatedMarkerBytes =
    truncatedMarker.length > 0 ? Buffer.from(truncatedMarker, "utf8") : null;

  return Effect.gen(function* () {
    let finalState: CollectState = {
      bytes: 0,
      truncated: false,
    };

    const chunks = yield* input.stream.pipe(
      Stream.mapAccum(
        (): CollectState => ({
          bytes: 0,
          truncated: false,
        }),
        (state, chunk) => {
          if (state.truncated) {
            finalState = state;
            return [state, []] as const;
          }

          const remainingBytes = maxBytes - state.bytes;
          if (remainingBytes <= 0) {
            const nextState: CollectState = {
              ...state,
              truncated: true,
            };
            finalState = nextState;
            return [nextState, truncatedMarkerBytes ? [truncatedMarkerBytes] : []] as const;
          }

          const nextChunk =
            chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
          const nextState: CollectState = {
            bytes: state.bytes + nextChunk.byteLength,
            truncated: chunk.byteLength > remainingBytes,
          };
          finalState = nextState;

          if (nextState.truncated && truncatedMarkerBytes) {
            return [nextState, [nextChunk, truncatedMarkerBytes]] as const;
          }

          return [nextState, [nextChunk]] as const;
        },
      ),
      Stream.runCollect,
    );

    const parts = Array.from(chunks);
    const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const text = Buffer.concat(parts, totalBytes).toString("utf8");

    return {
      text,
      bytes: finalState.bytes,
      truncated: finalState.truncated,
    } satisfies CollectedUint8StreamText;
  });
};
