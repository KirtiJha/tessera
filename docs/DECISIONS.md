# Decisions

The "why" log. Each entry has the choice, the reason and what it costs.

## 1. TypeScript end to end for v1
**Choice.** The server, console, contract and reporter are all TypeScript in one pnpm workspace; the implementation plan had Go for the server.
**Why.** One typed contract (`@tessera/contract`) is imported by all three, so a schema change breaks the build in every place at once instead of being discovered at runtime. A single language lets a small team own the whole system.
**Cost.** No single static binary yet. A Go ingest edge remains the plan when fan-in volume calls for it; the contract is the seam.

## 2. Claude Code hooks, not a plugin, for the first reporter
**Choice.** The reporter is a Node script driven by Claude Code's settings hooks; token usage is read from the session's JSONL transcript.
**Why.** Hooks are documented, stable and work for every install, including managed ones; the plugin API is newer and changes faster. The transcript carries exact per-request usage and model ids.
**Cost.** No status line inside the session, no per-step effort, and permission prompts can only be answered while the `PermissionRequest` hook waits (55 s by default) before Claude Code's own dialog takes over.

## 3. Snapshot plus unacknowledged events on the wire
**Choice.** Every report is the whole session plus the events the server has not acknowledged.
**Why.** A lost, duplicated or re-ordered report cannot corrupt state; a restarted server recovers from the next report.
**Cost.** Larger reports; at one per hook call that is fine.

## 4. PostgreSQL for everything, Redis optional
**Choice.** Sessions, agents, events, per-second samples, asks, deliveries and the audit log are all in PostgreSQL. Redis is only for fan-out across replicas.
**Why.** One durable store a platform team already runs; row-level tenancy by `org_id`; no second system until the samples table says so.
**Cost.** Per-second samples at thousands of sessions will outgrow a single table; the plan's ClickHouse tier is the next step and the `samples` table is the only part that moves.

## 5. Identity from the device token, never from the payload
**Choice.** A report is accepted only with a device token; the owner is the token's user. A session that already belongs to another user is refused (409).
**Why.** A name in a payload can be typed by anyone.
**Cost.** A machine shared by two people needs two config directories (`TESSERA_HOME`).

## 6. Cost priced on read
**Choice.** Tokens per model are stored; dollars are computed when read with the organisation's price table laid over the built-in list prices. A model with no price is shown as unpriced, never as zero.
**Why.** A contracted-rate change must move every figure at once, and an invented number is worse than none.
**Cost.** Budget spend uses the cost recorded in each sample at ingest time, so a price change does not re-open a closed budget window.

## 7. Enforcement through the PreToolUse hook
**Choice.** A hard budget with enforcement, or a paused session, denies new tool calls with a reason the engineer sees in the terminal. Tessera never kills a process.
**Why.** It is the strongest action a hook can take without reaching into the machine, and it is reversible from the console.
**Cost.** The model keeps its context and can keep thinking; only tool use stops.

## 8. Append-only, hash-chained audit with canonical JSON
**Choice.** Every mutation writes an audit row whose hash covers canonical JSON of its content and the previous row's hash.
**Why.** An auditor can verify the log was not edited. Canonical JSON because `jsonb` does not preserve key order (found by the first chain verification).
**Cost.** One extra `SELECT` per mutation to fetch the previous hash; audit writes within an org are serialised by that order.

## 9. Reporter writes use synchronous_commit off
**Choice.** The ingest path has its own Postgres pool whose connections run with `synchronous_commit = off`. Everything else (sign-in, answers to sessions, budgets, audit) keeps full durability.
**Why.** A report is a full snapshot that the reporter sends again a second later, so losing the last fraction of a second of reports in a database crash loses nothing the next report does not restore. It removes a WAL flush from every report, and the separate pool means a burst of reports never makes the console wait for a connection.
**Cost.** Activity events in the lost window can be gone for good, because the reporter dropped them after the acknowledgement. They are short activity lines, not audit records.

## 10. Live counts on the wall come from the session list, not the KPI tick
**Choice.** Live sessions, waiting sessions and running agents shown on the wall are counted in the browser from the same session list the filters and cards use. The server's KPIs supply only figures that need the database (cost today, tokens per minute, blowouts).
**Why.** The two sources update on different clocks (500 ms batches and a 2 s tick), so the same screen showed three different "waiting" numbers under load.
**Cost.** None worth noting; the server still computes the live counts for API clients.

## 11. Motion on the wall is reserved for what needs attention
**Choice.** Running-agent squares are static; only the top-bar live dot and the ring around a waiting card animate, and both animate opacity on their own layer.
**Why.** A wall of a hundred pulsing squares cost a third of the browser's main thread at 500 sessions and drowned out the one signal that matters: a session waiting on someone.
**Cost.** A running agent is shown by colour and the "N agents working" line rather than by movement.

## 12. Single sign-on is OIDC first, bound to the provider's subject
**Choice.** SSO is OpenID Connect (authorization code with PKCE, ID tokens checked against the provider's JWKS), one provider per organisation, routed by email domain. SAML waits until a customer needs it.
**Why.** Okta, Entra ID, Google Workspace, Auth0 and Keycloak all speak OIDC, and it needs no XML signature handling, which is where SAML implementations usually go wrong.
**Safeguards.** A provider signs in only users of its own organisation, so a misconfigured or hostile provider cannot assert someone else's email into another org. The first SSO sign-in binds the user to the provider's (issuer, subject); after that, an identity with the same email but a different subject is refused, so re-using an email at the provider does not take over an account (an owner can unlink). Only owners change SSO settings, so an admin cannot point the org at a provider that impersonates an owner. Public email domains cannot be claimed, and a domain belongs to one organisation. Requiring SSO leaves owners their password as a way back in when the provider is down.
**Cost.** Domains are claimed without DNS verification yet; an owner could claim a domain they do not control and route that domain's sign-ins to their provider. Accounts in other organisations are still protected (the provider can only sign in its own members), but DNS TXT verification should come before general availability. No SCIM yet: people removed at the provider keep their Tessera account until an admin disables it, though they can no longer sign in when SSO is required.

## 13. Answering from Slack is the console's answer, made by a person Slack vouches for
**Choice.** Slack buttons call the same `answerAsk` path as the console: the session must be live, the prompt still open, and the person allowed to act on the session. The Slack user is matched to a Tessera user by the email Slack holds for them, in the channel's organisation only, and the match is remembered per Slack workspace and user. Every request is checked against the app's signing secret and a five-minute timestamp window before anything in it is read as an instruction.
**Why.** A second, weaker way to approve a tool call would undo the rules the console enforces. Email is the one identifier both systems already agree on, and Slack verifies it.
**Cost.** Someone whose Slack email differs from their Tessera email cannot answer from Slack until an admin fixes one of them; they are told so privately. Each organisation brings its own Slack app (a manifest is provided) rather than installing a shared one, so there is no OAuth install flow to run, and no Tessera-operated app holds tokens for many companies.

## 14. Notifications close themselves
**Choice.** When a waiting prompt is answered (anywhere) or the session moves on, Tessera edits its Slack messages to remove the buttons and say who answered, and resolves its PagerDuty incident. Channels can wait before notifying, so a team-lead or on-call channel only hears about sessions still waiting after, say, fifteen minutes.
**Why.** Stale buttons invite a second answer to a question that is gone, and an incident nobody resolves teaches people to ignore the pager.
**Cost.** Waiting state is held in the server's memory; a restart re-notifies channels with a delay about prompts that were already waiting (the notification log stops a channel being told twice about the same prompt).
