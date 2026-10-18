import { describe, expect, it } from "vitest";
import { evaluatePolicy, globMatch, PolicyDoc, type PolicyRule } from "./policy.js";

const rule = (r: Partial<PolicyRule> & { match: Partial<PolicyRule["match"]> }): PolicyRule =>
  PolicyDoc.parse({ rules: [{ id: r.id ?? "r", name: r.name ?? "rule", effect: r.effect ?? "deny", mode: r.mode, enabled: r.enabled, reason: r.reason, match: r.match }] }).rules[0]!;

describe("globMatch", () => {
  it("matches commands with * across anything", () => {
    expect(globMatch("terraform apply*", "terraform apply -auto-approve")).toBe(true);
    expect(globMatch("terraform apply*", "terraform plan")).toBe(false);
    expect(globMatch("*rm -rf /*", "sudo rm -rf /var")).toBe(true);
    expect(globMatch("git push ?rigin main", "git push origin main")).toBe(true);
  });
  it("keeps * inside one path segment and lets ** cross", () => {
    expect(globMatch("src/*.ts", "src/a.ts", true)).toBe(true);
    expect(globMatch("src/*.ts", "src/x/a.ts", true)).toBe(false);
    expect(globMatch("src/**/*.ts", "src/a.ts", true)).toBe(true);
    expect(globMatch("src/**/*.ts", "src/x/y/a.ts", true)).toBe(true);
    expect(globMatch("**/.env", "/home/me/app/.env", true)).toBe(true);
    expect(globMatch("**/.env", ".env", true)).toBe(true);
    expect(globMatch("infra/prod/**", "infra/prod/main.tf", true)).toBe(true);
    expect(globMatch("infra/prod/**", "infra/staging/main.tf", true)).toBe(false);
  });
  it("takes linear-ish time on hostile input", () => {
    const t0 = performance.now();
    expect(globMatch("*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(2000))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("evaluatePolicy", () => {
  const doc = {
    rules: [
      rule({ id: "allow-plan", effect: "allow", match: { tools: ["Bash"], commands: ["terraform plan*"] } }),
      rule({ id: "ask-tf", effect: "ask", reason: "Terraform needs a reviewer", match: { tools: ["Bash"], commands: ["terraform *"] } }),
      rule({ id: "env", effect: "deny", match: { tools: ["Read", "Edit", "Write"], paths: ["**/.env", ".env*"] } }),
      rule({ id: "dry", effect: "deny", mode: "dry_run", match: { tools: ["WebFetch"] } }),
      rule({ id: "off", effect: "deny", enabled: false, match: { tools: ["*"] } }),
      rule({ id: "main", effect: "ask", match: { tools: ["Bash"], commands: ["git push*"], branches: ["main", "release/*"] } }),
      rule({ id: "mcp", effect: "deny", match: { tools: ["mcp__prod_db__*"] } }),
    ],
  };
  it("lets the first matching rule decide, so an allow above carves an exception", () => {
    expect(evaluatePolicy(doc, { tool: "Bash", command: "terraform plan -out x" }).decision).toBe("allow");
    const v = evaluatePolicy(doc, { tool: "Bash", command: "terraform apply" });
    expect(v.decision).toBe("ask");
    expect(v.rule?.reason).toBe("Terraform needs a reviewer");
  });
  it("catches a command hidden in a chain", () => {
    expect(evaluatePolicy(doc, { tool: "Bash", command: "cd infra && terraform destroy" }).rule?.id).toBe("ask-tf");
  });
  it("matches paths absolute, relative to the session, or by file name", () => {
    expect(evaluatePolicy(doc, { tool: "Read", paths: ["/repo/app/.env"], cwd: "/repo" }).decision).toBe("deny");
    expect(evaluatePolicy(doc, { tool: "Edit", paths: ["/repo/.env.local"], cwd: "/repo" }).decision).toBe("deny");
    expect(evaluatePolicy(doc, { tool: "Read", paths: ["/repo/src/env.ts"], cwd: "/repo" }).decision).toBe("allow");
  });
  it("reports dry-run rules without applying them, and skips disabled ones", () => {
    const v = evaluatePolicy(doc, { tool: "WebFetch", url: "https://example.com" });
    expect(v.decision).toBe("allow");
    expect(v.dryRun.map((r) => r.id)).toEqual(["dry"]);
  });
  it("needs every condition a rule sets", () => {
    expect(evaluatePolicy(doc, { tool: "Bash", command: "git push origin HEAD", branch: "feature/x" }).decision).toBe("allow");
    expect(evaluatePolicy(doc, { tool: "Bash", command: "git push origin HEAD", branch: "release/2.1" }).rule?.id).toBe("main");
    expect(evaluatePolicy(doc, { tool: "mcp__prod_db__query" }).decision).toBe("deny");
  });
});
