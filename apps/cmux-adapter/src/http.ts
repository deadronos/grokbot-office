export type Post = (path: string, body: unknown) => Promise<void>;

export const REQUEST_TIMEOUT_MS = 5000;

/** A five-second timeout keeps a hung office from wedging the poll loop. */
export function createPost(
  baseUrl: string,
  token: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Post {
  const url = baseUrl.replace(/\/+$/, "");
  return async (path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The status alone is safe to log; response bodies are not needed.
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  };
}
