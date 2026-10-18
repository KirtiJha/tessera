import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Conf {
  server: string;
  key: string;
}

export const confPath = () => join(process.env.TESSERA_HOME ?? join(homedir(), ".tessera"), "cli.json");

/** Server and key from TESSERA_URL / TESSERA_API_KEY, else ~/.tessera/cli.json. */
export function loadConf(): Conf | null {
  const env = { server: process.env.TESSERA_URL, key: process.env.TESSERA_API_KEY };
  if (env.server && env.key) return { server: env.server.replace(/\/+$/, ""), key: env.key };
  const p = confPath();
  if (!existsSync(p)) return null;
  const c = JSON.parse(readFileSync(p, "utf8")) as Partial<Conf>;
  const server = (env.server ?? c.server)?.replace(/\/+$/, "");
  const key = env.key ?? c.key;
  return server && key ? { server, key } : null;
}

export function saveConf(c: Conf): void {
  const p = confPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function clearConf(): void {
  rmSync(confPath(), { force: true });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the versioned API with the key; errors carry the server's message. */
export class Client {
  constructor(private conf: Conf) {}

  async raw(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    const res = await fetch(`${this.conf.server}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.conf.key}`, accept, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* not json */
      }
      throw new ApiError(res.status, msg || `HTTP ${res.status}`);
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.raw("GET", path)).json()) as T;
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await (await this.raw("POST", path, body)).json()) as T;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await (await this.raw("PUT", path, body)).json()) as T;
  }

  /** Server-Sent Events from /fleet/stream, as (event, data) pairs, until the connection closes. */
  async *stream(signal?: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
    const res = await fetch(`${this.conf.server}/api/v1/fleet/stream`, { headers: { authorization: `Bearer ${this.conf.key}`, accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new ApiError(res.status, `stream: HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
      }
    }
  }
}
