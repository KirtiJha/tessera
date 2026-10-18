import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { perDevice } from "./ingest.js";

describe("reporter rate limits", () => {
  it("are per device token, so machines behind one IP do not starve each other", async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
    app.post("/r", { config: perDevice(3) }, async () => ({ ok: true }));
    const hit = (token: string) => app.inject({ method: "POST", url: "/r", headers: { authorization: `Bearer ${token}` }, remoteAddress: "10.0.0.1" });

    for (let i = 0; i < 3; i++) expect((await hit("tsr_a")).statusCode).toBe(200);
    expect((await hit("tsr_a")).statusCode).toBe(429);
    // Same IP, different device: its own budget.
    expect((await hit("tsr_b")).statusCode).toBe(200);
    await app.close();
  });
});
