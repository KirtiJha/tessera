export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // No content-type without a body: Fastify answers 400 to a DELETE that claims JSON and sends none.
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(path, {
    method,
    headers: { "x-tessera-client": "web", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    body: payload,
    credentials: "same-origin",
    // A change finishes even if the page is left or reloaded at once (away mode, then a reload). The browser caps such a body at 64 KB.
    keepalive: method !== "GET" && (payload?.length ?? 0) < 60_000,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => call<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => call<T>("DELETE", path),
};
