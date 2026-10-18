import type { FastifyReply } from "fastify";
import type { StreamMessage } from "@tessera/contract";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { constants as zc, createGzip, type Gzip } from "node:zlib";
import { config } from "../config.js";

/** A connected browser. Writes go through gzip when the browser accepts it, flushed per message. */
export interface StreamClient {
  write(chunk: string): void;
  close(): void;
  /** Bytes queued for this client and not yet sent. */
  backlog(): number;
}

/** A client that falls this far behind is disconnected; it reconnects and gets a fresh snapshot. */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

export function openStream(reply: FastifyReply, acceptEncoding: string | undefined): StreamClient {
  const gzip = /\bgzip\b/.test(acceptEncoding ?? "");
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(gzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
  });
  let z: Gzip | null = null;
  if (gzip) {
    // Z_SYNC_FLUSH after every write: compression without holding messages back.
    z = createGzip({ flush: zc.Z_SYNC_FLUSH, level: 6 });
    z.pipe(reply.raw);
  }
  return {
    write: (chunk) => {
      if (z) z.write(chunk);
      else reply.raw.write(chunk);
    },
    close: () => {
      if (z) z.end();
      else reply.raw.end();
    },
    backlog: () => reply.raw.writableLength + (z?.writableLength ?? 0),
  };
}

/**
 * Fan-out of fleet messages to browsers. Each org has its own channel. With
 * REDIS_URL set, messages are published through Redis so every replica sees
 * them; otherwise they stay in-process.
 */
/** A change to the live set, sent between replicas so each holds the same sessions. */
export type ReplicaMessage = { op: "set"; orgId: string; rec: unknown } | { op: "remove"; orgId: string; id: string };

export class StreamHub {
  private clients = new Map<string, Set<StreamClient>>();
  /** This process, so it ignores its own replica messages. */
  readonly instance = randomUUID();
  private onReplica: ((m: ReplicaMessage) => void) | null = null;
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  readonly maxClientsPerOrg = 500;

  constructor(private log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {}

  async start(): Promise<void> {
    if (!config.redisUrl) return;
    this.pub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.sub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await this.pub.connect();
    await this.sub.connect();
    await this.sub.psubscribe("tessera:org:*");
    await this.sub.subscribe("tessera:fleet");
    this.sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
      const orgId = channel.slice("tessera:org:".length);
      this.deliver(orgId, message);
    });
    this.sub.on("message", (channel: string, message: string) => {
      if (channel !== "tessera:fleet" || !this.onReplica) return;
      const sep = message.indexOf("|");
      if (message.slice(0, sep) === this.instance) return;
      try {
        this.onReplica(JSON.parse(message.slice(sep + 1)) as ReplicaMessage);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, "stream: bad replica message");
      }
    });
    this.log.info({}, "stream: redis fan-out enabled");
  }

  async stop(): Promise<void> {
    for (const set of this.clients.values()) for (const c of set) c.close();
    this.clients.clear();
    await this.pub?.quit();
    await this.sub?.quit();
  }

  /** Register a client; it is removed when `onClose` fires. Returns false when the org is at its client limit. */
  add(orgId: string, client: StreamClient, onClose: (cb: () => void) => void): boolean {
    let set = this.clients.get(orgId);
    if (!set) this.clients.set(orgId, (set = new Set()));
    if (set.size >= this.maxClientsPerOrg) return false;
    set.add(client);
    onClose(() => {
      set!.delete(client);
      if (set!.size === 0) this.clients.delete(orgId);
    });
    return true;
  }

  clientCount(): number {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }

  hasClients(orgId: string): boolean {
    return (this.clients.get(orgId)?.size ?? 0) > 0;
  }

  orgsWithClients(): string[] {
    return [...this.clients.keys()];
  }

  broadcast(orgId: string, msg: StreamMessage): void {
    const line = `event: ${msg.type}\ndata: ${JSON.stringify(msg.data)}\n\n`;
    if (this.pub) {
      this.pub.publish(`tessera:org:${orgId}`, line).catch((e: Error) => this.log.warn({ err: e.message }, "stream: publish failed"));
      return;
    }
    this.deliver(orgId, line);
  }

  /** True when changes are shared with other replicas. */
  get replicated(): boolean {
    return this.pub !== null;
  }

  /** Tell the other replicas about a change to the live set. */
  replicate(m: ReplicaMessage): void {
    if (!this.pub) return;
    this.pub.publish("tessera:fleet", `${this.instance}|${JSON.stringify(m)}`).catch((e: Error) => this.log.warn({ err: e.message }, "stream: replicate failed"));
  }

  /** Receive the other replicas' changes. */
  listen(handler: (m: ReplicaMessage) => void): void {
    this.onReplica = handler;
  }

  /** Send directly to one client (the snapshot on connect). */
  send(client: StreamClient, msg: StreamMessage): void {
    client.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg.data)}\n\n`);
  }

  private deliver(orgId: string, line: string): void {
    const set = this.clients.get(orgId);
    if (!set) return;
    for (const c of set) {
      if (c.backlog() > MAX_BACKLOG_BYTES) {
        this.log.warn({ orgId }, "stream: dropping a client that fell behind");
        set.delete(c);
        c.close();
        continue;
      }
      try {
        c.write(line);
      } catch {
        set.delete(c);
      }
    }
  }
}
