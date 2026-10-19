import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

const calls: { url: string; init: RequestInit }[] = [];
const ok = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("api", () => {
  it("sends a JSON body with its content type, and the client header on every call", async () => {
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => (calls.push({ url, init }), Promise.resolve(ok())));
    await api.post("/api/x", { a: 1 });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-tessera-client"]).toBe("web");
    expect(calls[0]!.init.body).toBe('{"a":1}');
  });

  it("sends no content type on a bodiless DELETE or GET, which Fastify would otherwise reject as empty JSON", async () => {
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => (calls.push({ url, init }), Promise.resolve(ok())));
    await api.del("/api/admin/budgets/b1");
    await api.get("/api/admin/budgets");
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
      expect(c.init.body).toBeUndefined();
    }
  });

  it("turns an error response into an ApiError carrying the server's message", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ error: "no such budget" }), { status: 404 })));
    await expect(api.del("/api/admin/budgets/nope")).rejects.toMatchObject({ status: 404, message: "no such budget" } satisfies Partial<ApiError>);
  });
});
