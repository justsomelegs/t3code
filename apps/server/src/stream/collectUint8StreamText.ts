import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  readonly parts: string[];
  readonly bytes: number;
  readonly truncated: boolean;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const decoder = new TextDecoder();
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({
        parts: [],
        bytes: 0,
        truncated: false,
      }),
      (state, chunk): CollectState => {
        if (state.truncated) {
          return state;
        }

        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) {
          if (truncatedMarker.length > 0) {
            state.parts.push(truncatedMarker);
          }
          return {
            ...state,
            truncated: true,
          };
        }

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        const text = decoder.decode(nextChunk, { stream: true });
        if (text.length > 0) {
          state.parts.push(text);
        }
        const bytes = state.bytes + nextChunk.byteLength;
        const truncated = chunk.byteLength > remainingBytes;
        if (truncated && truncatedMarker.length > 0) {
          state.parts.push(truncatedMarker);
        }

        return {
          parts: state.parts,
          bytes,
          truncated,
        };
      },
    ),
    Effect.map((state): CollectedUint8StreamText => {
      if (!state.truncated) {
        const trailingText = decoder.decode();
        if (trailingText.length > 0) {
          state.parts.push(trailingText);
        }
      }

      return {
        text: state.parts.join(""),
        bytes: state.bytes,
        truncated: state.truncated,
      };
    }),
  );
};
