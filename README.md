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
| `packages/mod-claude` | The Tessera mod for Claude Code 2.1.287 and later, installed beside the hooks: delivers a message from the console to a session idle at its prompt, adds `/tessera` (connection, away mode) and an away-mode band above the prompt, and hands the reporter Claude Code's own context and cost figures. |

## Run it

### Try it on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/KirtiJha/tessera)

`render.yaml` creates the web service from the Dockerfile and a PostgreSQL database, generates `SECRET_KEY`, and uses the service's `onrender.com` address as `PUBLIC_URL`. Open the address when the deploy finishes and create your organisation. On the free plan the service sleeps after 15 idle minutes and the database is deleted after 30 days.

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

One line on the machine that runs Claude Code. Every Tessera server serves its own installer with its address filled in, and the reporter that matches its version.

1. In the console, open **Devices** and get an enrolment code (valid 15 minutes, works once). The page shows the line below with your address and code filled in.
2. Paste it in a terminal on the machine:
   ```sh
   # macOS and Linux
   curl -fsSL https://tessera.example.com/install.sh | sh -s -- --code XXXX-XXXX
   ```
   ```powershell
   # Windows (PowerShell)
   $env:TESSERA_CODE = "XXXX-XXXX"; irm https://tessera.example.com/install.ps1 | iex
   ```
   The script downloads the reporter into `~/.tessera/bin`, enrols the machine, adds Tessera's hooks to Claude Code's `~/.claude/settings.json` without touching anything else there, and runs a self-check (`doctor`) that says what to fix if anything is off. Hooks are registered in Claude Code's exec form (a Node executable plus arguments, no shell), which behaves the same on macOS, Linux and Windows. If Node 20 or newer is not installed, the script fetches a private copy into `~/.tessera/node`; nothing else on the machine changes. Running the line again is safe: an enrolled machine keeps its token and the hooks are refreshed. On Claude Code 2.1.287 or later it also installs the **Tessera mod** from a plugin marketplace directory at `~/.tessera/claude-plugins` (registered in the same `settings.json` under `extraKnownMarketplaces` and `enabledPlugins`; `tessera-reporter install --no-mod` skips it). The mod runs inside Claude Code with your permissions, reads the device token from `~/.tessera/config.json` and talks only to your Tessera server; `claude plugin validate ~/.tessera/claude-plugins/tessera` lists every call it makes. Where an organisation's managed settings allow only its own mods, the hooks work as before without it.
3. Start a Claude Code session. It appears within two seconds of its first prompt.

Afterwards, the command the installer prints at the end runs `doctor` (checks Node, enrolment, the server, the token and the hooks), `status`, or `uninstall` (removes the hooks; the device token stays until you delete `~/.tessera/config.json`).

For CI runners, issue a token in **Devices → Issue a token by hand** and run the installer with `--token tsr_…` (or `$env:TESSERA_TOKEN` on Windows) instead of a code. With Node already installed, the manual route still works: `npx -y --package=$TESSERA/downloads/tessera-reporter.tgz tessera-reporter enrol --server $TESSERA --code XXXX-XXXX`, then `… install`.

### What the reporter sends, and when

Only to your server, only with the device token, and only this: the session id, working directory, git repo, branch and dirty-file count, model, token counts per model (read from the transcript), context fill (Claude Code's own figure when the mod runs, kept per minute for the context timeline), compactions, the plan state, each subagent's type, status, tokens and tool-call counts, the first 400 characters of an agent's task and answer, short event lines, the last 40 tool calls as one-line summaries with their outcome and duration, and, while a prompt is open, what is being asked in full: the whole command, an edit's before and after text, the first part of a file about to be written, the URL, the agent's last message before asking, and the allow rules Claude Code suggests. Keys, tokens, passwords and high-entropy strings are replaced with `[redacted]` before anything is sent. Transcripts and model thinking are never sent. Tool output is sent only where an owner turns on **Keep command output** (Data and compliance): then the last 40 lines a command printed, and a failed call's whole error, redacted on the machine and sent once. Each call also carries its whole command, its description, path or pattern, and the lines an edit adds and removes. **Keep edit history**, also off by default, keeps each edit's and write's patch (up to 20,000 characters, redacted, sent once) so changes stay viewable after they are committed. Every tool call is kept for the events retention period, so the session page pages through the whole session, not only the last 40 calls. Beyond the open prompt's own edit, one thing is read from disk, and only when a person asks: **a session's uncommitted diff**. Someone who can act on the session (its owner, an approver on their team, or an admin) opens a changed file in the console; the request reaches the machine with the next report (the keep-alive's, within about 10 s); the reporter runs `git diff HEAD` for the 40 biggest changes (a new file is sent as its first 256 KB), redacts it the same way, caps it at 20,000 characters a file and 200,000 in all, and sends it. The server applies the organisation's DLP and holds it **in memory for 15 minutes**, never in the database; every request is in the audit log (`session.diff`). An organisation set to metadata only, or a machine with `"excerpts": false` in `~/.tessera/config.json`, sends no diffs.

On a network whose web filter blocks a report's content (a 403 with an HTML page rather than Tessera's JSON), the reporter sends the report again with free-text detail withheld (tool names without arguments, no command, diff or excerpt), so the session still shows with its state, cost and timing, marked **detail withheld**. Its keep-alive then finds which lines the filter objects to (usually one command, such as a `curl` with `$(…)` in it) by sending halves of them, at most 24 requests every two minutes, and from then on withholds only those, marked on their row; the rest of the session is shown in full. `doctor` detects such a filter and says what to ask your network team for. Request timeouts follow the measured round trip to your server, so a slow proxy does not make hooks fail.

### How acting on a session works

Tessera never connects to an engineer's machine. The reporter posts snapshots and, in its reply, receives any deliveries queued for the session:

- A **permission prompt** (`PermissionRequest` hook) is shown on the wall with the actual change or command, risk flags (deletes files, rewrites history, changes infrastructure or a database, runs downloaded code, touches secrets, writes outside the project, and so on), the agent's own reason, the policy rule that forced the prompt if one did, and the tool calls just before it. The hook waits up to 55 s for an answer from the console, then falls back to the terminal dialog. An answer from the console is returned to Claude Code as the hook's decision. **Allow for the rest of this session** also returns a session-scoped permission rule (`updatedPermissions`, destination `session`), so the agent stops asking about that pattern until the session ends; nothing is written to settings files.
- A **question** (`AskUserQuestion`, caught in the `PreToolUse` hook) is shown with its options; an answer from the console within 20 s is returned as the tool's `answers`, so the terminal never shows the dialog. After that the terminal asks as usual.
- A **plan** (`ExitPlanMode`) works the same way: approve or send back with feedback.
- A **message** reaches a working session when its turn ends (`Stop` hook), as an instruction to continue with. With the **Tessera mod** (Claude Code 2.1.287 or later), a session idle at its prompt gets it at once as a new prompt, marked as sent by the tessera plugin; without the mod it waits for that session's next turn. The console says which applies before you send. Whichever hook's report collects a message or an answer keeps it for the hook it is meant for, so none is lost when a tool hook happens to report first.
- While a session waits at the terminal or runs a long tool call, no hooks fire. A small per-session **keep-alive** started by the first hook refreshes it every 10 s (without taking answers or messages, which stay queued for the next hook), so it stays on the wall. It exits with Claude Code.
- **Where you answer prompts** (top bar, or `/tessera away`, `/tessera desk` and `/tessera back` in the terminal with the mod): *At my desk* hands prompts to the terminal after ~10 s, *Away* holds them up to 10 min for the console or a phone notification. With the mod, a band above the prompt says when away mode is on, with an **I'm back** button. A prompt shows a countdown while it can be answered here and says plainly once the terminal has it. Re-run the installer on each machine to get the longer hook timeouts.
- **Pause** and a reached **hard budget with enforcement** deny every new tool call (`PreToolUse` hook) with a reason the engineer sees in the terminal.
- **Stop** refuses the session's next tool call and ends its turn (`continue: false`), handing control back to the engineer. It applies once.
- **Hand over** gives a colleague the session for a while: they are told when it waits, and can answer, stop or pause it.

Every figure with a **?** beside it says how it is worked out (cost, tokens, context, cache share, waits, the change on the period before), on hover, keyboard focus or a tap. Every session has a **Replay** tab: a scrubber over its whole run with cost, prompts waiting on people, agents, failures and policy decisions laid on it, and the session's state at the playhead. The playhead is in the URL (`?tab=replay&t=754`, seconds from the start), so **Copy link** shares a moment, and a click on a failure, a prompt, a policy denial or a compaction on the overview's timeline opens the replay there. The timeline also draws how full the **context window** was minute by minute, with the 80% and 90% lines and each compaction. An ended session opens with a **summary card**: how it ended and after how long, what it left behind (files changed, commits to push), cost and cache share, agents and failures, time spent waiting on people, plan progress and the most used tools. Each tool call in **Activity** opens to its whole command, why it ran, lines changed, and its output where kept; **Show the whole session's tool calls** loads the rest of the history. **Change history** lists every kept edit, file by file, in order, even after a commit or the end of the session. **Files changed** opens each file to its diff, fetched from the machine when asked (see what leaves the machine, above). A session started in one folder and told to work on another repo (by `cd` or absolute paths) is followed there: its writes and leading `cd`s move it, reads do not, and the timeline notes each move. One that worked in several shows **Worked in**, each repository with its branch, its own uncommitted files and their diffs; it stays one session, since it is one Claude Code conversation with one bill. **Compare** puts two sessions side by side (cost, time, tokens, agents, failures, waits, tool calls); pick two in History or start from a session.

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

Each group shows its change against the period of the same length just before (▲ amber when spend rose, ▼ teal when it fell, **new** when there was none). A team or a person opens their own page: spend per day against the period before, the repositories it went on, how long their prompts waited and how quickly they answered other people's, what they have live now and their recent sessions, and for a team each member's share. Names on People and teams, on a session and in the search palette (⌘K) lead there too. Analytics opens on a given period from a link (`/app/analytics?from=2026-10-12&to=2026-10-18`, with `&team=` and `&groupBy=`).

## Policies

Under **Policies**, admins write rules checked before every tool call on every enrolled machine. The first rule that matches decides:

- **Deny** refuses the call; the engineer sees the rule's reason in the terminal.
- **Ask** stops for approval; the prompt appears on the wall and in Slack, where an approver can allow it.
- **Allow** lets the call through, as an exception above a broader rule.

Rules match on tool (`Bash`, `Edit`, `mcp__github__*`), command (`terraform apply*`), path (`**/.env`, `infra/prod/**`), URL, model, repository, branch and team, all as globs. Any rule can run as a **dry run** first, recording who it would have stopped. The page tests a tool call against the rules as you edit them, lists recent decisions, and keeps every saved version so you can roll back. Templates cover the usual starting points: Terraform, secrets files, pushes to main, destructive shell commands, production MCP tools.

## Notifications and answering from Slack

Under **Notifications**, an admin adds channels for the events that matter: a session waiting on someone, an agent failing, a context window overflowing, a budget limit, a policy denial, a session going silent, and two made from the daily spend:

- **Spend alert**: a day's spend more than three standard deviations above the two weeks before it (and at least $5 above their mean), for the organisation or for one team. Yesterday is checked once it is complete, and today as soon as it has crossed the line, so a runaway shows the same day. Each scope and day alerts once, with a link to the team's page.
- **Weekly digest**: on Monday from 08:00 UTC, last Monday-to-Sunday week: spend against the week before, the top teams with their change, the costliest sessions, how many prompts waited on people and how fast they were settled, failed agents and blowouts. **Send last week's digest** shows it in the channel now.

A channel's events can be changed in place. Email is not a channel: Tessera has no mail server to send from; a webhook to your mail relay does the job.

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
- **Explain failures with Claude** (off by default, and only offered once the server has `ANTHROPIC_API_KEY`): a failed tool call or agent gets **Explain this failure**, which sends that failure's error output (already redacted on the machine, with your removals above applied again), the calls just before it and the repository name to the Claude API, and shows a three-line answer: what failed, the likely cause, what to try. Only people who can act on the session may ask; an answer is kept a day so asking twice costs once; each organisation may ask `EXPLAIN_PER_HOUR` times an hour (60); every request is audited (`session.explain`). Nothing else is ever sent to a model, and metadata-only organisations cannot turn it on.

## Roles

| Role | Can |
| --- | --- |
| viewer | watch the wall, read history and spend |
| operator | also answer and control their own sessions, enrol their own devices |
| approver | also act on any session in their team |
| admin | also act on any session; manage people, teams, budgets, prices, notifications; read the audit log |
| owner | everything, including other owners |

## Configuration

See [`.env.example`](.env.example). `DATABASE_URL` and (in production) `SECRET_KEY` are required. `REDIS_URL` turns on fan-out across replicas. `PUBLIC_URL` and `ALLOWED_HOSTS` decide which `Host` headers the server accepts in production. `ANTHROPIC_API_KEY` (a secret, set it in your platform's secret store), `EXPLAIN_MODEL` (`claude-haiku-5-5`) and `ANTHROPIC_API_URL` (for a gateway) enable **Explain this failure**.

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
