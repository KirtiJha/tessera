import { describe, expect, it } from "vitest";
import { atLeast, canActOn, type Principal } from "./rbac.js";

const p = (role: Principal["role"], teamId: string | null = "t1"): Principal => ({ userId: "u1", orgId: "o", teamId, role, name: "n", email: "e" });

describe("rbac", () => {
  it("ranks roles", () => {
    expect(atLeast("admin", "operator")).toBe(true);
    expect(atLeast("viewer", "operator")).toBe(false);
    expect(atLeast("owner", "owner")).toBe(true);
  });
  it("owner of a session can act when at least operator", () => {
    expect(canActOn(p("operator"), { ownerId: "u1", teamId: null })).toBe(true);
    expect(canActOn(p("viewer"), { ownerId: "u1", teamId: null })).toBe(false);
  });
  it("approver acts only within their team", () => {
    expect(canActOn(p("approver", "t1"), { ownerId: "u2", teamId: "t1" })).toBe(true);
    expect(canActOn(p("approver", "t1"), { ownerId: "u2", teamId: "t2" })).toBe(false);
    expect(canActOn(p("approver", null), { ownerId: "u2", teamId: null })).toBe(false);
  });
  it("someone a session is handed to can act on it", () => {
    expect(canActOn(p("operator"), { ownerId: "u2", teamId: "t2", assigneeId: "u1" })).toBe(true);
    expect(canActOn(p("viewer"), { ownerId: "u2", teamId: "t2", assigneeId: "u1" })).toBe(false);
    expect(canActOn(p("operator"), { ownerId: "u2", teamId: "t2", assigneeId: "u3" })).toBe(false);
  });
  it("admins act anywhere; operators not on others' sessions", () => {
    expect(canActOn(p("admin"), { ownerId: "u2", teamId: "t9" })).toBe(true);
    expect(canActOn(p("operator"), { ownerId: "u2", teamId: "t1" })).toBe(false);
  });
});
