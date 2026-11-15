import { StreamEvent } from "@grokbot-office/shared";

export const STREAM_PATH = "/api/stream";

export type StreamHandlers = {
  onOpen: () => void;
  onPing: () => void;
  onEvent: (event: StreamEvent) => void;
  onError: () => void;
};

/** Bad or unknown frames are dropped, never thrown: one bad event must not kill the stream. */
function parseFrame(data: unknown): StreamEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = StreamEvent.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens the SSE stream. `EventSource` reconnects on its own and resumes with the
 * `Last-Event-ID` header, so the store only has to mirror its state.
 */
export function openMessageStream(handlers: StreamHandlers): () => void {
  const source = new EventSource(STREAM_PATH, { withCredentials: true });
  source.addEventListener("open", handlers.onOpen);
  source.addEventListener("error", handlers.onError);
  source.addEventListener("ping", handlers.onPing);
  source.addEventListener("event", (frame) => {
    const event = parseFrame((frame as MessageEvent).data);
    if (event) handlers.onEvent(event);
  });
  return () => source.close();
}
