<p align="left"><img src="apps/web/public/brand/tessera-logo.svg" alt="Tessera" width="360"></p>

**Tessera is the control plane for fleets of AI coding agents.** Every Claude Code session in your organisation shows up on one live wall: its model, plan, agents, context window and cost. When one stops to ask, answer it from the console or from Slack. When one overspends, Tessera denies its tool calls until the budget resets.

Self-hosted on PostgreSQL. Nothing leaves a session except what you turn on. Apache-2.0.

## What is in the box

| Part | What it does |
| --- | --- |
| `apps/server` | Fastify API: sign-in, organisations and roles, device enrolment, telemetry ingest, live fleet state with a Server-Sent-Events stream, history, budgets with enforcement, model pricing, Slack and webhook notifications, hash-chained audit log. PostgreSQL for everything; Redis optional for several replicas. |
| `apps/web` | The console: landing page, live wall, session pages with a respond panel, history, spend, devices, people and teams, budgets, prices, notifications, audit. React 19, Tailwind 4, Framer Motion. |
| `packages/contract` | The typed telemetry schema (`zod`), price table, redaction and the view types shared by server, web and reporters. |
| `packages/cli` | The `tessera` command line, over the public API. Served by the server at `/downloads/tessera-cli.tgz`. |
| `deploy/helm/tessera` | Helm chart for Kubernetes. |
| `e2e` | Browser end-to-end tests (Playwright) against a running server. |
| `packages/reporter-claude` | The Claude Code reporter, driven by Claude Code's hooks. Reads token usage from the session transcript, answers permission prompts from the console, delivers messages, enforces budgets. |

## Run it

### With Docker

```sh
cp .env.example .env            # set SECRET_KEY and PUBLIC_URL at least
docker compose up -d
open http://localhost:4700      # create your organisation on the landing page
```

Set `BOOTSTRAP_ORG_NAME`, `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to create the first organisation at start instead of through the sign-up page.

### On Kubernetes

```sh
helm install tessera deploy/helm/tessera \
  --set publicUrl=https://tessera.example.com \
  --set secret.databaseUrl='postgres://…/tessera?sslmode=require' \
  --set secret.secretKey=$(openssl rand -hex 32) \
  --set ingress.enabled=true --set ingress.host=tessera.example.com
```

PostgreSQL is not bundled; use your managed database. For more than one replica (or autoscaling) set `redis.url`: replicas share the live fleet and the browser stream through Redis, so a report to one replica and an answer on another meet. The chart runs the container read-only as a non-root user, sets ingress annotations for the long-lived stream, and refuses to render a multi-replica install without Redis. Prefer `existingSecret` (keys `DATABASE_URL`, `SECRET_KEY`, optionally `REDIS_URL`, `METRICS_TOKEN`) over values on the command line.

### From source

Requires Node 22, pnpm 10 and a PostgreSQL 15+ database.

```sh
pnpm install
pnpm --filter @tessera/contract build
export DATABASE_URL=postgres://tessera:tessera@localhost:5432/tessera
export SECRET_KEY=$(openssl rand -hex 32)
pnpm dev                        # server on :4700, Vite console on :5173 (proxies /api)
```

Production from source: `pnpm build` then `pnpm start`; the server serves the built console itself.

## Put a session on the wall

Every Tessera server hands out the reporter itself at `/downloads/tessera-reporter.tgz`: one file, no dependencies, always the version that matches the server. Machines need Node 20 or newer.

1. In the console, open **Devices** and get an enrolment code. The page shows the commands below with your address filled in.
2. On the machine that runs Claude Code:
   ```sh
   TESSERA=https://tessera.example.com
   npx -y --package=$TESSERA/downloads/tessera-reporter.tgz tessera-reporter enrol --server $TESSERA --code XXXX-XXXX
   npx -y --package=$TESSERA/downloads/tessera-reporter.tgz tessera-reporter install
   ```
   `install` copies the reporter to `~/.tessera/bin` and adds its hooks to `~/.claude/settings.json` without touching anything else there. Afterwards, `node ~/.tessera/bin/tessera-reporter.mjs status` shows the connection and `… uninstall` removes the hooks.
3. Start a Claude Code session. It appears within two seconds of its first prompt.

For CI runners, issue a token in **Devices → Issue a token by hand** and use `enrol --server $TESSERA --token tsr_…` instead of a code.

### What the reporter sends, and when

Only to your server, only with the device token, and only this: the session id, working directory, git repo, branch and dirty-file count, model, token counts per model (read from the transcript), context fill, compactions, the plan state, each subagent's type, status, tokens and tool-call counts, the first 400 characters of an agent's task and answer, short event lines, and, while a permission prompt is open, the tool and a one-line summary of its arguments. Keys, tokens, passwords and high-entropy strings are replaced with `[redacted]` before anything is sent. File contents, diffs, transcripts and model thinking are never sent.

### How acting on a session works

Tessera never connects to an engineer's machine. The reporter posts snapshots and, in its reply, receives any deliveries queued for the session:

- A **permission prompt** (`PermissionRequest` hook) is shown on the wall; the hook waits up to 55 s for an answer from the console, then falls back to the terminal dialog. An answer from the console is returned to Claude Code as the hook's decision.
- A **plan** (`ExitPlanMode`) works the same way: approve or send back with feedback.
- A **message** is delivered the next time the session pauses (`Stop` hook) as an instruction to continue with.
- **Pause** and a reached **hard budget with enforcement** deny every new tool call (`PreToolUse` hook) with a reason the engineer sees in the terminal.
- **Stop** refuses the session's next tool call and ends its turn (`continue: false`), handing control back to the engineer. It applies once.
- **Hand over** gives a colleague the session for a while: they are told when it waits, and can answer, stop or pause it.

Every session has a **Replay** tab: a scrubber over its whole run with cost, prompts waiting on people, agents, failures and policy decisions laid on it, and the session's state at the playhead. **Compare** puts two sessions side by side (cost, time, tokens, agents, failures, waits, tool calls); pick two in History or start from a session.

Only the session's owner, an approver on their team, or an admin can act; every action is written to the audit log.

### Other agent runtimes (OpenTelemetry)

Any runtime that exports OpenTelemetry traces with the GenAI semantic conventions can report without Tessera code on the machine. Issue a device token, then:

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=$TESSERA/api/ingest/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer tsr_…"
```

`invoke_agent` spans become agents (nested by span parentage), `chat` spans carry `gen_ai.usage.*` tokens per model, `execute_tool` spans count tool calls and failures; `session.id` (or `gen_ai.conversation.id`, else the trace) groups spans into a session, and `vcs.*` attributes fill in the repository and branch. Gzip is accepted; protobuf is not. Traces are watch-only: answering, pausing and policy need a first-party reporter.

## Single sign-on

Owners connect an OpenID Connect provider under **Single sign-on**: Okta, Microsoft Entra ID, Google Workspace, or any OIDC provider. People type their work email on the sign-in page and are sent to the provider when their domain uses SSO. Options: create accounts on first sign-in with a default role, and require SSO (members lose password sign-in; owners keep theirs as a way back in).

Tessera uses the authorization code flow with PKCE and validates ID tokens against the provider's published keys. A provider can only sign in members of its own organisation, and once someone has signed in through SSO, only that provider identity signs them in again. Public email domains cannot be claimed.

Each email domain must be **verified** with a DNS TXT record (`_tessera-verify.<domain>`) before sign-ins for it go to your provider or accounts are created for it; only one organisation can verify a domain.

**SCIM 2.0 provisioning.** Generate a SCIM token under Single sign-on and point Okta or Entra ID at `https://<your Tessera>/scim/v2`. The provider creates people, keeps names in step, and deactivates them when they leave (their browser sessions end at once; devices and API keys stop with them). Groups become teams. Roles stay a Tessera decision, and owners cannot be deactivated through SCIM.

To try it locally without an Okta or Entra account, run the development provider and use issuer `http://127.0.0.1:4800`, client ID `tessera-dev`, client secret `dev-secret`:

```sh
pnpm --filter @tessera/dev-idp start
```

It signs in whoever you type, so it is for development only.

## Analytics and chargeback

**Analytics** shows estimated spend per day with a forecast for the month, unusual days marked, and spend grouped the way finance asks for it: by team, cost centre (set per team), person, repository, ticket (found in branch names with a pattern you set, `PAY-142` in `feat/PAY-142-refunds` by default) or any tag. Engineers tag sessions when they start Claude Code:

```sh
TESSERA_TAGS="project=apollo,ticket=PAY-142" claude
```

It also shows the share of prompts answered in Tessera (and from Slack), the mean wait for an answer, agent failure rate and context blowouts. Admins download chargeback CSV per group or per session with every allocation column. Cost per session per UTC day is rolled up from the per-minute samples, so spend history outlives the samples' retention.

## Policies

Under **Policies**, admins write rules checked before every tool call on every enrolled machine. The first rule that matches decides:

- **Deny** refuses the call; the engineer sees the rule's reason in the terminal.
- **Ask** stops for approval; the prompt appears on the wall and in Slack, where an approver can allow it.
- **Allow** lets the call through, as an exception above a broader rule.

Rules match on tool (`Bash`, `Edit`, `mcp__github__*`), command (`terraform apply*`), path (`**/.env`, `infra/prod/**`), URL, model, repository, branch and team, all as globs. Any rule can run as a **dry run** first, recording who it would have stopped. The page tests a tool call against the rules as you edit them, lists recent decisions, and keeps every saved version so you can roll back. Templates cover the usual starting points: Terraform, secrets files, pushes to main, destructive shell commands, production MCP tools.

## Notifications and answering from Slack

Under **Notifications**, an admin adds channels for the events that matter: a session waiting on someone, an agent failing, a context window overflowing, a budget limit, a policy denial, a session going silent.

| Channel | What it does |
| --- | --- |
| Slack app | Posts with **Allow**/**Deny** on permission prompts and **Approve plan**/**Send back…** on plans. The answer is made as the person who pressed, matched by their Slack email, under the same rules as the console, and audited. The message updates to say who answered. |
| Slack webhook, Microsoft Teams | A message or adaptive card with a link to the session. |
| PagerDuty | Opens an incident (Events API v2) and resolves it when the session moves on. |
| Webhook | JSON to any https endpoint, signed: `X-Tessera-Signature: t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`. |

Any channel can wait before it hears about a waiting session (2, 5 or 15 minutes, an hour), which makes escalation channels a one-line setup. For the Slack app, the page gives you a manifest to paste into api.slack.com; set the interactivity URL to `https://<your Tessera>/api/integrations/slack/actions`.

## API and command line

Make an API key under **API keys**. A key acts as the person who made it, with their current role, limited to the scopes picked (`fleet:read`, `sessions:act`, `analytics:read`, `audit:read`, `policy:read`, `policy:write`), and can expire. The public API is the console's own API under `/api/v1`, described at `/api/v1/openapi.json` (OpenAPI 3.1).

The `tessera` CLI is served by your server, like the reporter:

```sh
npx -y --package=$TESSERA/downloads/tessera-cli.tgz tessera login --server $TESSERA
tessera sessions --waiting          # what is waiting on someone
tessera watch                       # a line (and a bell) when a session starts waiting
tessera allow 3f9c                  # answer by id prefix or name; deny, approve, reject, answer, message
tessera pause 3f9c --reason "freeze" ; tessera stop 3f9c
tessera spend --days 30 --by cost_center
tessera export --by cost_center --from 2026-10-01 --to 2026-10-31 -o october.csv
tessera policy get -o policy.json   # edit, review in Git, then:
tessera policy apply policy.json --note "Block prod MCP tools"
```

In CI, set `TESSERA_URL` and `TESSERA_API_KEY` instead of logging in. `policy apply` shows the diff and refuses to overwrite a version saved since you read it.

## Data and compliance

Under **Data and compliance**, owners decide what Tessera keeps:

- **Metadata only** drops prompt text and agent excerpts before they are stored.
- **Data-loss prevention** removes email addresses, payment card numbers (Luhn-checked), US Social Security numbers, IBANs (checksum-verified) and any words you list, such as customer or project names. Secrets are always removed, on the machine and again on the server.
- **Retention** per organisation for samples, events and sessions. The audit log is never pruned, so its hash chain verifies from the first entry.
- **Legal hold** stops all pruning and erasure until it is released.
- **Audit export** as JSON lines or CSV, and **streaming** to Splunk (HEC), Datadog or any NDJSON endpoint within about 15 seconds, in order, retried from where a failure stopped.
- **A person's data**: export everything Tessera keeps about someone, or erase it. Their sessions, devices and keys are deleted, and their name and email are replaced; the audit log keeps its entries.

## Roles

| Role | Can |
| --- | --- |
| viewer | watch the wall, read history and spend |
| operator | also answer and control their own sessions, enrol their own devices |
| approver | also act on any session in their team |
| admin | also act on any session; manage people, teams, budgets, prices, notifications; read the audit log |
| owner | everything, including other owners |

## Configuration

See [`.env.example`](.env.example). `DATABASE_URL` and (in production) `SECRET_KEY` are required. `REDIS_URL` turns on fan-out across replicas. `PUBLIC_URL` and `ALLOWED_HOSTS` decide which `Host` headers the server accepts in production.

## Performance

Tested at 500 concurrent sessions, each reporting every second: 496 reports a second sustained, report-to-wall p95 under 700 ms, and the browser's main thread about 12% busy with the wall open. The method, the load generator (`tools/loadgen`) and the before/after numbers are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). `GET /api/metrics` serves Prometheus metrics to loopback, or with `METRICS_TOKEN`.

## Development

```sh
pnpm typecheck
pnpm test          # unit tests, plus integration tests when DATABASE_URL (and Redis) are reachable
pnpm build
pnpm --filter @tessera/e2e e2e   # browser tests against a running server (E2E_BASE_URL)
```

CI runs all of it against real PostgreSQL and Redis, installs the reporter and the CLI with `npx` from the running server, runs the browser tests, builds the container and runs it read-only as the chart does, and lints and validates the Helm chart.

## Design notes

- The telemetry contract is snapshot-plus-events: each report carries the whole session and the events the server has not acknowledged. A lost, duplicated or re-ordered report cannot corrupt state.
- Identity comes from the device token, never from a name in the payload.
- Cost is priced when read, from tokens per model and the organisation's price table, so a price change moves every figure at once. A model with no price shows as unpriced rather than as zero.
- Nothing about a session's content is stored unless the reporter sends it, and the reporter sends excerpts only when `excerpts` is on in its config (default on, 400 characters).
