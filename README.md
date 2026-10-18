<p align="left"><img src="apps/web/public/brand/tessera-logo.svg" alt="Tessera" width="360"></p>

**Tessera is the control plane for fleets of AI coding agents.** Every Claude Code session in your organisation shows up on one live wall: its model, plan, agents, context window and cost. When one stops to ask, answer it from the console or from Slack. When one overspends, Tessera denies its tool calls until the budget resets.

Self-hosted on PostgreSQL. Nothing leaves a session except what you turn on. Apache-2.0.

## What is in the box

| Part | What it does |
| --- | --- |
| `apps/server` | Fastify API: sign-in, organisations and roles, device enrolment, telemetry ingest, live fleet state with a Server-Sent-Events stream, history, budgets with enforcement, model pricing, Slack and webhook notifications, hash-chained audit log. PostgreSQL for everything; Redis optional for several replicas. |
| `apps/web` | The console: landing page, live wall, session pages with a respond panel, history, spend, devices, people and teams, budgets, prices, notifications, audit. React 19, Tailwind 4, Framer Motion. |
| `packages/contract` | The typed telemetry schema (`zod`), price table, redaction and the view types shared by server, web and reporters. |
| `packages/reporter-claude` | The Claude Code reporter, driven by Claude Code's hooks. Reads token usage from the session transcript, answers permission prompts from the console, delivers messages, enforces budgets. |

## Run it

### With Docker

```sh
cp .env.example .env            # set SECRET_KEY and PUBLIC_URL at least
docker compose up -d
open http://localhost:4700      # create your organisation on the landing page
```

Set `BOOTSTRAP_ORG_NAME`, `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to create the first organisation at start instead of through the sign-up page.

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

1. In the console, open **Devices** and get an enrolment code.
2. On the machine that runs Claude Code:
   ```sh
   pnpm --filter @tessera/reporter-claude build     # once, from this repo (npm package to follow)
   node packages/reporter-claude/bin/tessera-reporter.js enrol --server https://tessera.example.com --code XXXX-XXXX
   node packages/reporter-claude/bin/tessera-reporter.js install
   ```
   `install` adds Tessera's hooks to `~/.claude/settings.json` without touching anything else there. `status` shows the connection; `uninstall` removes the hooks.
3. Start a Claude Code session. It appears within two seconds of its first prompt.

### What the reporter sends, and when

Only to your server, only with the device token, and only this: the session id, working directory, git repo, branch and dirty-file count, model, token counts per model (read from the transcript), context fill, compactions, the plan state, each subagent's type, status, tokens and tool-call counts, the first 400 characters of an agent's task and answer, short event lines, and, while a permission prompt is open, the tool and a one-line summary of its arguments. Keys, tokens, passwords and high-entropy strings are replaced with `[redacted]` before anything is sent. File contents, diffs, transcripts and model thinking are never sent.

### How acting on a session works

Tessera never connects to an engineer's machine. The reporter posts snapshots and, in its reply, receives any deliveries queued for the session:

- A **permission prompt** (`PermissionRequest` hook) is shown on the wall; the hook waits up to 55 s for an answer from the console, then falls back to the terminal dialog. An answer from the console is returned to Claude Code as the hook's decision.
- A **plan** (`ExitPlanMode`) works the same way: approve or send back with feedback.
- A **message** is delivered the next time the session pauses (`Stop` hook) as an instruction to continue with.
- **Pause** and a reached **hard budget with enforcement** deny every new tool call (`PreToolUse` hook) with a reason the engineer sees in the terminal.

Only the session's owner, an approver on their team, or an admin can act; every action is written to the audit log.

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

## Development

```sh
pnpm typecheck
pnpm test          # contract, server and reporter unit tests
pnpm build
```

The CI workflow runs the same, plus the migrations against a real PostgreSQL and a container build.

## Design notes

- The telemetry contract is snapshot-plus-events: each report carries the whole session and the events the server has not acknowledged. A lost, duplicated or re-ordered report cannot corrupt state.
- Identity comes from the device token, never from a name in the payload.
- Cost is priced when read, from tokens per model and the organisation's price table, so a price change moves every figure at once. A model with no price shows as unpriced rather than as zero.
- Nothing about a session's content is stored unless the reporter sends it, and the reporter sends excerpts only when `excerpts` is on in its config (default on, 400 characters).
