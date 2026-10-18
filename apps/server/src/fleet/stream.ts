import type { FastifyReply } from "fastify";
import type { StreamMessage } from "@tessera/contract";
import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Fan-out of fleet messages to browsers. Each org has its own channel. With
 * REDIS_URL set, messages are published through Redis so every replica sees
 * them; otherwise they stay in-process.
 */
export class StreamHub {
  private clients = new Map<string, Set<FastifyReply>>();
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
    this.sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
      const orgId = channel.slice("tessera:org:".length);
      this.deliver(orgId, message);
    });
    this.log.info({}, "stream: redis fan-out enabled");
  }

  async stop(): Promise<void> {
    for (const set of this.clients.values()) for (const r of set) r.raw.end();
    this.clients.clear();
    await this.pub?.quit();
    await this.sub?.quit();
  }

  add(orgId: string, reply: FastifyReply): boolean {
    let set = this.clients.get(orgId);
    if (!set) this.clients.set(orgId, (set = new Set()));
    if (set.size >= this.maxClientsPerOrg) return false;
    set.add(reply);
    reply.raw.on("close", () => {
      set!.delete(reply);
      if (set!.size === 0) this.clients.delete(orgId);
    });
    return true;
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

  /** Send directly to one client (the snapshot on connect). */
  send(reply: FastifyReply, msg: StreamMessage): void {
    reply.raw.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg.data)}\n\n`);
  }

  private deliver(orgId: string, line: string): void {
    const set = this.clients.get(orgId);
    if (!set) return;
    for (const r of set) {
      try {
        r.raw.write(line);
      } catch {
        set.delete(r);
      }
    }
  }
}
