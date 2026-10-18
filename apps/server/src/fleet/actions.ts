import { ruleText } from "@tessera/contract";
import { audit } from "../audit.js";
import { canActOn, type Principal } from "../auth/rbac.js";
import { resolveNotifications } from "../notify/notifier.js";
import { waitKeyFor, type Fleet } from "./fleet.js";

export type Decision = "allow" | "deny" | "approve" | "reject" | "answer";
export type Via = "console" | "slack" | "api";

const VERB: Record<Decision, string> = { allow: "Allowed", deny: "Denied", approve: "Plan approved", reject: "Plan sent back", answer: "Answered" };
const VIA: Record<Via, string> = { console: "", slack: " from Slack", api: " through the API" };

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

/**
 * Answer the open prompt of a live session, from wherever the person is. The
 * same checks apply everywhere: the session is live, the prompt is the one
 * still open, and the person may act on this session. The answer is queued for
 * the reporter, written to the audit log, and every chat or paging notification
 * about the prompt is closed out with who answered.
 */
export async function answerAsk(
  fleet: Fleet,
  p: Principal,
  sessionId: string,
  body: { askId: string; decision: Decision; text?: string | null; option?: string | null; answers?: Record<string, string>; scope?: "once" | "session"; rule?: { tool: string; content: string | null } | null },
  via: Via,
  ctx: { ip?: string; log: { warn: (o: object, m: string) => void } },
): Promise<{ deliveryId: string; outcome: string }> {
  const rec = fleet.get(p.orgId, sessionId);
  if (!rec) fail(404, "That session is no longer live.");
  if (!canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId, assigneeId: rec.control.assignee?.id })) fail(403, "You cannot act on this session.");
  if (!rec.openAsk || rec.openAsk.id !== body.askId) fail(409, "That prompt is no longer open.");
  const sticky = body.scope === "session" && (body.decision === "allow" || body.decision === "approve") && body.rule ? body.rule : null;
  const payload = { decision: body.decision, text: body.text ?? null, option: body.option ?? null, ...(body.answers ? { answers: body.answers } : {}), by: p.name, via, scope: sticky ? "session" : "once", ...(sticky ? { rule: sticky } : {}) };
  const deliveryId = await fleet.queueDelivery(p.orgId, sessionId, "answer", body.askId, payload, p.userId);
  await audit({
    orgId: p.orgId,
    actorId: p.userId,
    actorName: p.name,
    action: `session.answer.${body.decision}`,
    targetType: "session",
    targetId: sessionId,
    detail: { askId: body.askId, kind: rec.openAsk.kind, deliveryId, via, ...(sticky ? { sessionRule: ruleText(sticky) } : {}), ...(rec.openAsk.detail?.command ? { command: rec.openAsk.detail.command.slice(0, 300) } : {}), ...(rec.openAsk.detail?.paths.length ? { paths: rec.openAsk.detail.paths.slice(0, 5) } : {}) },
    ip: ctx.ip,
  });
  const outcome = `${VERB[body.decision]} by ${p.name}${VIA[via]}${sticky ? ` (and ${ruleText(sticky)} for the rest of the session)` : ""}${body.text ? `: ${body.text.slice(0, 300)}` : body.option ? `: ${body.option.slice(0, 300)}` : "."}`;
  await resolveNotifications(p.orgId, waitKeyFor(p.orgId, sessionId, body.askId), outcome, ctx.log);
  return { deliveryId, outcome };
}
