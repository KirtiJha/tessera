# Performance

Tessera's beta gate is 500 concurrent sessions with the wall updating within a second. This page records how that is measured and what was found.

## How to measure

The load generator drives the real ingest API with simulated sessions (token counts that grow, agents that spawn, finish and fail, events, occasional waits) and subscribes to the console stream the way a browser does, timing each report until it reaches the stream.

```sh
pnpm --filter @tessera/loadgen start -- --server http://localhost:4700 \
  --email you@example.com --password '…' --sessions 500 --duration 60
```

It uses one device token per five sessions, like a real fleet of machines, and revokes them and ends its sessions at the end (`--keep` leaves them live so you can look at the wall). `--json` prints the summary as one line.

On the server, `GET /api/metrics` serves Prometheus metrics (ingest duration histogram, event-loop delay, both Postgres pools, live sessions, stream clients). It answers loopback requests, or anyone with `Authorization: Bearer $METRICS_TOKEN` when that is set. `?format=json` gives a short summary.

## Results, 18 Oct 2026

One machine with 2 cores and 7 GB, running PostgreSQL 16, the server, the load generator and (for the browser rows) headless Chromium, all sharing those 2 cores. Absolute numbers are pessimistic; the comparison is the point. 500 sessions, one report per session per second, 60 s.

| Server | Before | After |
| --- | --- | --- |
| Reports sustained | 402 / s of 500 | 496 / s |
| Ingest p50 / p99, server clock | not measured | 9 / 287 ms |
| Ingest p95 / p99, client clock | 1,685 / 5,140 ms | 133 / 804 ms |
| Report to wall p50 / p95 | 612 / 1,151 ms | 406 / 686 ms |
| Stream to each browser | 667 msg/s, 1,168 KB/s | 6 msg/s, 98 KB/s (gzip) |
| Postgres pool requests waiting, worst | 254 | 0 |

| Browser (Chromium, 1600×1000, wall open) | Before | After |
| --- | --- | --- |
| Main thread busy | 95% | 11–14% |
| Longest task | 1,683 ms | 149–205 ms |
| Frame rate (headless, no GPU) | 0.9 fps | 31–33 fps |
| DOM nodes | 19,718 | ~1,800 |
| JS heap | 80 MB | 17–22 MB |

With the browser open, the report-to-wall p95 rises to about 1.5 s on this machine because Chromium, the generator, the server and Postgres compete for 2 cores; on its own the server holds 686 ms.

## What changed, and why

Found by measuring, in the order they mattered:

1. **Rate limits were per IP.** At 600 reports a minute per address, the 100-session baseline had 2,503 of 3,003 reports refused, and a real office behind one NAT address would be locked out within a minute. Reporter routes are now limited per device token.
2. **Every report wrote every agent, in six round trips.** A report is now one statement: a data-modifying CTE that upserts the session, the agents that changed since the last write, new events, and claims waiting deliveries (`FOR UPDATE SKIP LOCKED`, so two concurrent reports never both receive one). Reporter writes use their own pool with `synchronous_commit = off`; see DECISIONS 9.
3. **Samples were one row per second** (1.8 M rows an hour at 500 sessions), and the KPI query ran a window function over an hour of them every 2 s. Samples are per-minute buckets written in batches every 5 s; KPI figures are cached with one refresh in flight per org.
4. **Budget checks stampeded** on cache expiry and held up every acknowledgement. They are single-flight and run after the acknowledgement is sent.
5. **The stream sent one message per session update.** Updates are batched per org every 500 ms and the stream is gzip-compressed with a flush per message; a client that falls 8 MB behind is dropped and reconnects to a fresh snapshot.
6. **The wall rendered all 500 cards** and animated each card and context bar in JavaScript. The wall is virtualized (only rows near the viewport exist), cards are memoised, entrance and bar animations are CSS, and only the waiting ring and the top-bar dot move: running-agent squares no longer pulse, which was also visual noise.
