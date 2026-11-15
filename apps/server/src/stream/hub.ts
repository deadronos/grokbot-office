/**
 * What one open stream exposes to the hub: a nudge to drain and a way to end it.
 * The hub stores no events, so a slow client never grows it.
 */
export type StreamClient = {
  /** Ask the client to drain; it serializes its own drains. */
  notify: () => void;
  /** Ends the stream and unregisters it. */
  close: () => void;
};

/** In-process fan-out: a route that stored events calls `notify()`. */
export type StreamHub = {
  add: (client: StreamClient) => void;
  remove: (client: StreamClient) => void;
  size: () => number;
  notify: () => void;
  /** Ends every open stream (shutdown). */
  closeAll: () => void;
};

export function createStreamHub(): StreamHub {
  const clients = new Set<StreamClient>();
  return {
    add: (client) => {
      clients.add(client);
    },
    remove: (client) => {
      clients.delete(client);
    },
    size: () => clients.size,
    notify: () => {
      for (const client of clients) client.notify();
    },
    closeAll: () => {
      // Set iteration tolerates the deletion each close performs.
      for (const client of clients) client.close();
    },
  };
}
