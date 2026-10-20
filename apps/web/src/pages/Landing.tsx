import { motion } from "framer-motion";
import { ArrowRight, Bell, Eye, Gauge, Lock, ScrollText, Workflow } from "lucide-react";
import { Link } from "react-router-dom";
import { Lockup, Mark } from "../components/Logo";
import { Mosaic } from "../components/Mosaic";
import { useAuth } from "../lib/auth";

const ease = [0.2, 0.8, 0.2, 1] as const;

export function Landing() {
  const { me } = useAuth();
  return (
    <div className="light min-h-full font-sans">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Lockup size={26} className="text-ink" textClass="text-[20px] text-ink" />
        <nav className="flex items-center gap-1 text-[14px]">
          <a href="#see" className="rounded-lg px-3 py-2 text-ash hover:text-ink">What you see</a>
          <a href="#act" className="rounded-lg px-3 py-2 text-ash hover:text-ink">Act</a>
          <a href="#govern" className="rounded-lg px-3 py-2 text-ash hover:text-ink">Govern</a>
          <a href="#install" className="rounded-lg px-3 py-2 text-ash hover:text-ink">Install</a>
          {me ? (
            <Link to="/app" className="ml-2 rounded-lg bg-ink px-4 py-2 font-medium text-paper hover:bg-slate-2">Open console</Link>
          ) : (
            <>
              <Link to="/signin" className="rounded-lg px-3 py-2 text-ink">Sign in</Link>
              <Link to="/signup" className="ml-1 rounded-lg bg-ink px-4 py-2 font-medium text-paper hover:bg-slate-2">Start free</Link>
            </>
          )}
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pt-16">
        <div>
          <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease }} className="font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-ink sm:text-[60px] lg:text-[66px]">
            One of your agents is waiting on you.
            <br />
            <span className="text-teal-600">Tessera says which.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.12 }} className="mt-6 max-w-[52ch] text-[18px] leading-relaxed text-ash">
            Every Claude Code session across your organisation on one wall: its model, plan, agents, context window and cost, live. When one stops to ask, answer it from the console or from Slack. When one overspends, Tessera stops it.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.24 }} className="mt-8 flex flex-wrap items-center gap-3">
            <Link to={me ? "/app" : "/signup"} className="inline-flex h-12 items-center gap-2 rounded-lg bg-ink px-5 text-[15px] font-medium text-paper hover:bg-slate-2">
              {me ? "Open the console" : "Create your organisation"} <ArrowRight size={16} />
            </Link>
            <a href="#install" className="inline-flex h-12 items-center rounded-lg border border-ink/15 px-5 text-[15px] font-medium text-ink hover:bg-paper-2">
              Install the reporter
            </a>
          </motion.div>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="mt-5 text-[13px] text-ash">
            Self-hosted. Nothing leaves a session except what you turn on. Apache-2.0 core.
          </motion.p>
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.8, ease, delay: 0.1 }} className="rounded-2xl border border-ink/10 bg-paper-2 p-5 sm:p-7">
          <Mosaic />
          <div className="mt-5 flex items-center justify-between text-[12.5px] text-ash">
            <span>84 sessions · 1 waiting on you</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-teal-600" /> live</span>
          </div>
        </motion.div>
      </section>

      {/* The problem */}
      <section className="border-y border-ink/10 bg-ink text-snow">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-20 lg:grid-cols-[1fr_1.2fr]">
          <h2 className="font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[42px]">
            Run a few agents at once and it happens within the hour.
          </h2>
          <div className="grid gap-6 text-[16px] leading-relaxed text-mist sm:grid-cols-2">
            <p>One session is stopped at a permission prompt. One has filled its context window and is compacting for the third time. A subagent failed ten minutes ago and nothing told you.</p>
            <p>The only way to find out is to click through every terminal, on every machine, for every engineer. That costs more attention than the work itself. Tessera is the single pane that makes the fleet legible, and the one place you can act on it.</p>
          </div>
        </div>
      </section>

      {/* What you see */}
      <section id="see" className="mx-auto max-w-6xl px-6 py-20">
        <div className="max-w-2xl">
          <h2 className="font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] text-ink sm:text-[42px]">Every session is a tile. The wall is the mosaic.</h2>
          <p className="mt-4 text-[17px] leading-relaxed text-ash">Each tile shows what a terminal cannot: the whole session at a glance, and its relation to everyone else's.</p>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-ink/10 bg-ink/10 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: Eye, title: "State you can read from across the room", body: "Running, waiting on you, background, silent, done. Each state has a colour and a shape, so a wall display works with the sound off." },
            { icon: Workflow, title: "The agent tree, not just the orchestrator", body: "Every subagent, fork and teammate a session launched, what each one costs, what it loaded, and why it failed when it did." },
            { icon: Gauge, title: "Context fill and blowouts", body: "How full every window is now and minute by minute, with each compaction on the timeline, so you know which session is about to lose its memory." },
            { icon: ScrollText, title: "The plan as the session sees it", body: "Task steps with their owner agent and status, straight from the session's own task list." },
            { icon: Bell, title: "Cost you can defend", body: "Tokens priced on read with your contracted rates per model, split by person, team, project and day. An estimate, labelled as one, never a surprise." },
            { icon: Lock, title: "History, replay and audit", body: "Every session that ran, summed up on one card, replayable to any moment you can link to, and every question asked and who answered it in a hash-chained log." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-paper p-7">
              <Icon size={20} className="text-teal-600" />
              <h3 className="mt-4 text-[17px] font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ash">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Act */}
      <section id="act" className="border-y border-ink/10 bg-paper-2">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
          <div>
            <h2 className="font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] text-ink sm:text-[42px]">Answer it where you are.</h2>
            <p className="mt-4 text-[17px] leading-relaxed text-ash">A session that waits is a session that costs. Tessera brings the prompt to you: allow or deny a tool, approve a plan, send a message, pause a runaway. From the console, or from the Slack message that told you.</p>
            <ul className="mt-6 space-y-3 text-[15px] text-ink">
              {["Allow, Deny and Approve buttons on the Slack message itself, answered as the person who pressed.", "Stop a runaway turn, pause a session, or hand it to a colleague before you step away.", "A message from the console reaches a session idle at its prompt at once, and /tessera away in the terminal holds prompts for your phone.", "Only the session's owner, their team's approvers or an admin can act, and every action is logged.", "Tessera never opens a connection to an engineer's machine. The reporter pulls, always."].map((t) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-[7px] h-2 w-2 shrink-0 rounded-[3px] bg-teal-600" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-ink/10 bg-ink p-5 text-snow shadow-[0_30px_60px_-40px_rgba(0,0,0,0.6)]">
            <div className="flex items-center gap-2 text-[12px] text-amber-400"><span className="h-2 w-2 rounded-sm bg-amber-400" /> Waiting on Priya · 48 s</div>
            <div className="mt-2 font-display text-[22px] font-semibold tracking-tight">payments-api · feat/refunds</div>
            <div className="mt-1 text-[13px] text-fog">Sonnet 4.5 · medium effort · 61% context · $1.42 so far</div>
            <div className="mt-4 rounded-lg border border-line bg-ink-2 p-3.5 text-[13.5px]">
              <div className="text-fog">Permission request</div>
              <div className="mt-1 font-mono text-[13px] text-snow">Bash(pnpm test --filter refunds)</div>
            </div>
            <div className="mt-3 flex gap-2">
              <span className="rounded-lg bg-teal-400 px-3.5 py-2 text-[13px] font-semibold text-ink">Allow once</span>
              <span className="rounded-lg border border-line-2 px-3.5 py-2 text-[13px] font-medium text-mist">Deny with a reason</span>
              <span className="ml-auto rounded-lg border border-line-2 px-3.5 py-2 text-[13px] font-medium text-mist">Message</span>
            </div>
          </div>
        </div>
      </section>

      {/* Govern */}
      <section id="govern" className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-12 lg:grid-cols-[1fr_1fr]">
          <div>
            <h2 className="font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] text-ink sm:text-[42px]">Guardrails that act, not just report.</h2>
            <p className="mt-4 text-[17px] leading-relaxed text-ash">Write rules that every tool call on every machine is checked against: deny reading secrets files, ask a reviewer before a Terraform apply, allow the exceptions. Try a rule as a dry run first and see who it would have stopped. Budgets do the same for spend: soft limits notify, hard limits deny new tool calls until the window resets.</p>
            <p className="mt-4 text-[17px] leading-relaxed text-ash">Then see where the money went, by team, cost centre, ticket or tag, each against the period before, with a page for every team and person, a forecast for the month and a chargeback file for finance. A day that spends far more than usual raises an alert the same day, and a weekly digest lands in Slack or Teams every Monday.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["Single sign-on and SCIM", "Okta, Entra ID or Google through OpenID Connect, with verified domains. Your provider creates people and switches them off when they leave."],
              ["Any agent runtime", "Claude Code through its hooks and the Tessera mod; Codex, Gemini and SDK agents through OpenTelemetry traces. One wall."],
              ["Data you decide to keep", "Metadata-only mode, PII removal, retention per organisation, legal hold, export and erasure. Code stays on the machine: a diff is fetched only when someone asks, and held in memory."],
              ["Hash-chained audit, streamed", "Every action in an append-only log you can verify in one click and stream to Splunk or Datadog."],
              ["API keys and a CLI", "Scoped keys that act as their maker. Watch, answer and apply policy as code from a terminal or CI."],
              ["Runs where you run", "One container and Postgres. A Helm chart with Redis for several replicas."],
            ].map(([t, b]) => (
              <div key={t} className="rounded-xl border border-ink/10 bg-paper-2 p-5">
                <h3 className="text-[15.5px] font-semibold text-ink">{t}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-ash">{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Install */}
      <section id="install" className="border-t border-ink/10 bg-ink text-snow">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[42px]">Up in three steps.</h2>
          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            {[
              { n: "1", t: "Run the server", c: "docker compose up -d\n# or: pnpm start, with DATABASE_URL set", d: "Postgres is the only requirement. Redis is optional, for more than one replica." },
              { n: "2", t: "Enrol a machine", c: "TESSERA=https://tessera.example.com\nnpx -y --package=$TESSERA/downloads/tessera-reporter.tgz \\\n  tessera-reporter enrol --server $TESSERA --code XXXX-XXXX", d: "Your server hands out the reporter itself. The one-time code comes from Devices in the console, which shows this command with your address filled in." },
              { n: "3", t: "Install the hooks", c: "npx -y --package=$TESSERA/downloads/tessera-reporter.tgz \\\n  tessera-reporter install", d: "Adds the hooks to ~/.claude/settings.json and keeps the rest of it, plus the Tessera mod on Claude Code 2.1.287 or later. Your next Claude Code session appears on the wall." },
            ].map((s) => (
              <div key={s.n} className="rounded-2xl border border-line bg-slate-1 p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-teal-400 font-display text-[14px] font-bold text-ink">{s.n}</span>
                  <h3 className="text-[16px] font-semibold">{s.t}</h3>
                </div>
                <pre className="mt-4 overflow-x-auto rounded-lg bg-ink p-3.5 font-mono text-[12.5px] leading-relaxed text-teal-300">{s.c}</pre>
                <p className="mt-3 text-[14px] leading-relaxed text-fog">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-6 py-10 text-[13px] text-ash sm:flex-row sm:items-center">
        <span className="inline-flex items-center gap-2"><Mark size={18} tone="var(--color-teal-600)" /> Tessera · every agent session, one mosaic.</span>
        <span>Apache-2.0 core. Built for teams that run fleets of coding agents.</span>
      </footer>
    </div>
  );
}
