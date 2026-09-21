# Technical Design: Support Ticket Assignment

Companion to [prd-ticket-assignment-automation.md](prd-ticket-assignment-automation.md). The PRD defines *what* we're building; this document defines *how*.

## 1. Overview

One Next.js app, one Postgres database via Prisma. The UI and the assignment API call the same route handlers — one request path, not two.

The tricky logic (overnight windows, DST, fairness tie-breaks) lives in pure functions that take `now` as a parameter instead of reading `Date.now()`, so DST edge cases are testable as plain assertions. Luxon handles the timezone math.

Two decisions matter most for review:

- **Time handling.** Windows are stored and evaluated in local wall-clock time (weekday + minutes + IANA zone), never precomputed into UTC. A DST transition needs no data migration — see §3, §7.
- **Concurrency.** A single in-process lock, scoped per company, prevents double-assignment and workload overshoot instead of a database lock. This assumes one running process — this trial's scope — see §6, §13.

---

## 2. Data Model

```prisma
model Company {
  id                        String   @id @default(cuid())
  name                      String
  supportTimezone           String   // IANA zone, e.g. "Asia/Kolkata"
  maxActiveTicketsPerAgent  Int      // shared workload limit, PRD §4.3

  agents               Agent[]
  availabilityWindows  AvailabilityWindow[]
  requiredSupportHours RequiredSupportHours[]
  tickets              Ticket[]
}

model Agent {
  id        String    @id @default(cuid())
  companyId String
  name      String
  email     String
  removedAt DateTime? // soft delete

  company         Company                   @relation(fields: [companyId], references: [id])
  windowMembers   AvailabilityWindowAgent[]
  assignedTickets Ticket[]                  @relation("TicketAssignee")
  assignments     Assignment[]

  @@index([companyId, removedAt])
}

model AvailabilityWindow {
  id          String   @id @default(cuid())
  companyId   String
  dayOfWeek   Int      // 1 = Monday .. 7 = Sunday (ISO); day the window STARTS
  startMinute Int      // 0..1439, minutes from local midnight
  endMinute   Int      // 0..1439; endMinute < startMinute = overnight
  timezone    String   // IANA zone the window is authored in
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  company Company @relation(fields: [companyId], references: [id])
  agents  AvailabilityWindowAgent[]

  @@index([companyId, dayOfWeek])
}

model AvailabilityWindowAgent {
  windowId  String
  companyId String  // denormalized for company-scoped queries
  agentId   String

  window AvailabilityWindow @relation(fields: [windowId], references: [id], onDelete: Cascade)
  agent  Agent              @relation(fields: [agentId], references: [id])

  @@id([windowId, agentId])
  @@index([companyId, agentId])
}

model RequiredSupportHours {
  id          String @id @default(cuid())
  companyId   String
  dayOfWeek   Int
  startMinute Int
  endMinute   Int    // company timezone; same overnight rule as AvailabilityWindow

  company Company @relation(fields: [companyId], references: [id])
  @@index([companyId])
}

model Ticket {
  id         String       @id @default(cuid())
  companyId  String
  status     TicketStatus @default(OPEN)
  assigneeId String?
  assignedAt DateTime?

  company    Company             @relation(fields: [companyId], references: [id])
  assignee   Agent?              @relation("TicketAssignee", fields: [assigneeId], references: [id])
  assignment Assignment?
  pending    PendingAssignment?

  @@index([assigneeId, status])
  @@index([companyId, status])
}

enum TicketStatus { OPEN IN_PROGRESS WAITING RESOLVED CLOSED }
// Terminal = RESOLVED | CLOSED

model Assignment {
  id          String   @id @default(cuid())
  companyId   String
  ticketId    String   @unique
  agentId     String
  assignedAt  DateTime @default(now())
  explanation Json     // §4.4 payload

  ticket Ticket @relation(fields: [ticketId], references: [id])
  agent  Agent  @relation(fields: [agentId], references: [id])

  @@unique([companyId, ticketId]) // idempotency guarantee
  @@index([agentId, assignedAt])  // "least recently assigned" tie-break
}

model PendingAssignment {
  companyId        String
  ticketId         String   @unique
  reasonCode       String   // NO_AVAILABLE_AGENT | ALL_AVAILABLE_AGENTS_AT_CAPACITY
  firstRequestedAt DateTime @default(now())
  lastAttemptedAt  DateTime @default(now())
  attemptCount     Int      @default(1)

  ticket Ticket @relation(fields: [ticketId], references: [id])

  @@id([companyId, ticketId])
  @@index([lastAttemptedAt])
}
```

### Design notes

- **Times are stored as minutes (`Int`), not SQL `TIME`.** Simpler comparisons, no driver/timezone surprises. UI renders `HH:mm`.
- **A window spanning several weekdays is one row per day**, created together — each day is edited and evaluated independently.
- **Agents are soft-deleted, not hard-deleted.** A hard delete would remove the join rows and hide the exact "stale window" problem the PRD wants surfaced.
- **`Assignment` is a separate, immutable record from `Ticket.assigneeId`.** The ticket holds the current owner (for workload counts); `Assignment` holds history and the explanation payload.
- **Cross-company checks live in application code, not the schema.** Fine since this service is the only writer this trial — §13 covers the DB-level hardening.
- **Seed data is assumed internally consistent** — a seeded ticket's assignee always matches its `Assignment` row.

---

## 3. Availability Evaluation

Windows are evaluated by projecting `now` into the window's own IANA zone — nothing is precomputed to UTC.

```ts
export function isWindowActiveAt(w: WindowSpec, now: DateTime): boolean {
  const local = now.setZone(w.timezone);
  const dow = local.weekday;                 // 1..7, ISO
  const min = local.hour * 60 + local.minute;

  if (w.startMinute < w.endMinute) {
    return dow === w.dayOfWeek && min >= w.startMinute && min < w.endMinute;
  }
  // overnight: [start, midnight) on dayOfWeek, then [midnight, end) next day
  const nextDay = (w.dayOfWeek % 7) + 1;
  return (dow === w.dayOfWeek && min >= w.startMinute)
      || (dow === nextDay      && min <  w.endMinute);
}
```

- **Start-inclusive, end-exclusive** — active at `startMinute`, not at `endMinute` (PRD §4.1).
- `startMinute === endMinute` is rejected at validation, so it never reaches this function.
- Overnight windows spill into the next day.

**DST** falls out of this for free, since a window is a wall-clock schedule ("Mondays 22:00–06:00, London" = whatever the London clock reads, every Monday):

- **Spring forward:** the skipped hour never occurs — a window covering only it is inactive that day.
- **Fall back:** the repeated hour occurs twice — a window covering it is active both times.

`now` is always passed in, never read from `Date.now()` — that's what makes DST boundaries testable as plain assertions.

---

## 4. Assignment Algorithm

### 4.1 Candidate gathering

One scoped query per company: every non-removed agent, with active ticket count and most recent assignment timestamp (both aggregates, one round trip). Windows load alongside and are evaluated in memory via §3.

### 4.2 Eligibility filter (PRD §4.3)

An agent is eligible when:

1. It belongs to the company and hasn't been removed.
2. At least one of its windows is active right now (§3).
3. Its active ticket count is below the company's limit.

Agents that fail keep a reason (`UNAVAILABLE`, `AT_CAPACITY`, `REMOVED`), so a pending result can explain precisely.

### 4.3 Fairness ranking (PRD §4.4)

Eligible agents are ranked, in order:

1. Fewest active tickets.
2. Least recently assigned (never-assigned ranks first).
3. Agent ID, ascending — a tie-break only, not a fairness signal. It exists purely so identical inputs always produce one deterministic winner.

### 4.4 Explanation (PRD §4.6)

The decisive rule is the first ranking key on which the winner and the runner-up differ:

```jsonc
{
  "selected_agent": { "id": "agt_7", "name": "Priya" },
  "eligibility": { "available_via_window": "win_3", "active_tickets": 2, "limit": 5 },
  "decided_by": "FEWEST_ACTIVE_TICKETS",
  "runner_up": { "id": "agt_2", "active_tickets": 3 },
  "considered": [
    { "agent_id": "agt_9", "eligible": false, "reason": "AT_CAPACITY" },
    { "agent_id": "agt_4", "eligible": false, "reason": "UNAVAILABLE" }
  ]
}
```

`decided_by` is `ONLY_ELIGIBLE_AGENT` when there's no runner-up. Persisted to `Assignment.explanation`, so "why them?" is answerable weeks later.

---

## 5. API

Errors share one envelope:

```jsonc
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [] } }
```

### `POST /api/assignments`

Request: `{ "company_id": "cmp_1", "ticket_id": "tkt_42" }`

`POST`, not `GET` — this establishes a durable decision. It's idempotent, backed by `UNIQUE (companyId, ticketId)` (§6).

**200 — assigned:**

```jsonc
{
  "status": "assigned",
  "ticket_id": "tkt_42",
  "assignee": { "id": "agt_7", "name": "Priya" },
  "idempotent_replay": false, // true when returning a previously stored decision
  "explanation": { /* §4.4 */ }
}
```

**200 — pending** (PRD §4.7 — a valid answer, not an error):

```jsonc
{
  "status": "pending",
  "ticket_id": "tkt_42",
  "reason": "ALL_AVAILABLE_AGENTS_AT_CAPACITY",
  "next_retry_at": "2026-09-20T09:19:03.118Z",
  "considered": [ /* per-agent rejection reasons */ ]
}
```

| Reason code | Condition |
| --- | --- |
| `NO_AVAILABLE_AGENT` | No agent is inside an active window right now. |
| `ALL_AVAILABLE_AGENTS_AT_CAPACITY` | At least one agent is available; all are at the limit. |

If any agent is available, the reason is always the capacity one — the more actionable problem.

**Errors:**

| Status | Code | When |
| --- | --- | --- |
| 422 | `VALIDATION_FAILED` | Malformed `company_id`/`ticket_id` |
| 404 | `COMPANY_NOT_FOUND` / `TICKET_NOT_FOUND` | — |
| 422 | `TICKET_COMPANY_MISMATCH` | Ticket belongs to another company |
| 409 | `TICKET_TERMINAL` | Ticket already `RESOLVED`/`CLOSED` |
| 503 | `SERVICE_UNAVAILABLE` (`Retry-After: 5`) | Lock or transaction timeout |

`pending` and `503` mean different things: `pending` means the rules ran and no agent qualified; `503` means evaluation never finished (§6).

### Availability CRUD

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/companies/:companyId/availability-windows` | Includes agents; stale ones flagged `is_stale`. |
| `POST` | `/api/companies/:companyId/availability-windows` | `days_of_week: number[]` creates one row per day, one transaction. |
| `PATCH` | `/api/availability-windows/:windowId` | Full replace of that one day-row. |
| `DELETE` | `/api/availability-windows/:windowId` | Cascades the join rows. |

Body:

```jsonc
{ "days_of_week": [1, 2, 3], "start_time": "22:00", "end_time": "06:00", "timezone": "Asia/Kolkata", "agent_ids": ["agt_7"] }
```

Validation (all `422 VALIDATION_FAILED`, PRD §4.1):

| Rule | Check |
| --- | --- |
| Known timezone | valid IANA zone |
| Times well-formed | `HH:mm` |
| Start ≠ end | rejected if equal |
| At least one agent | non-empty |
| Agents belong to the company | non-removed, matching `companyId` |
| Days valid | non-empty, each in 1–7 |

`endMinute < startMinute` is allowed — that's the overnight case.

### `GET /api/companies/:companyId/coverage?week_start=YYYY-MM-DD`

Coverage for the Monday-starting week containing `week_start` (defaults to current week), in the company timezone (§7).

```jsonc
{
  "timezone": "Asia/Kolkata",
  "required": [ { "start": "2026-09-14T09:00:00+05:30", "end": "2026-09-14T18:00:00+05:30" } ],
  "covered":  [ { "start": "2026-09-14T09:00:00+05:30", "end": "2026-09-14T13:00:00+05:30", "agent_ids": ["agt_7"] } ],
  "gaps":     [ { "start": "2026-09-14T13:00:00+05:30", "end": "2026-09-14T18:00:00+05:30", "duration_minutes": 300 } ]
}
```

`start`/`end` carry a UTC offset rather than bare `HH:mm` — that's what lets a fall-back week show both passes of a repeated local hour as separate intervals (§7).

### `GET /api/companies/:companyId/agents`

Agents with `active_ticket_count`, `is_available_now`, `removed_at`.

### `POST /api/internal/retry-pending`

Runs one pending-assignment sweep synchronously, so the retry path is testable without a 5-minute wait. Returns `{ "swept": 4, "assigned": 1, "still_pending": 3 }`.

---

## 6. Concurrency and Idempotency

Two races have to be closed:

- **Race A — same ticket assigned twice.** Two concurrent calls for one ticket both see no existing assignment and both insert.
- **Race B — capacity overshoot.** Two concurrent calls for *different* tickets both see agent X under the limit and both pick X, pushing X over it.

Both are closed by **one in-process lock, keyed per company**: only one assignment transaction runs per company at a time. This assumes a single running process — this trial's scope (§13 has the multi-instance fix, via Postgres advisory locks).

Lock behaviour:

- Requests for the same company queue in order (FIFO).
- A request waits up to 2s for its turn. If that wait times out, its transaction never starts, and it returns `503` — there's nothing to roll back.
- Once a request starts, the lock is held until its transaction (5s timeout) actually commits or rolls back — the next request starts only then, not when a waiting request simply gives up. This is what keeps a slow transaction and a timed-out waiter from ever running at the same time.

Inside the lock, the transaction:

1. Returns the existing assignment if the ticket is already assigned (idempotent replay).
2. Validates the ticket belongs to the company and isn't terminal.
3. Runs eligibility and fairness (§4) and either assigns the ticket or marks it pending.
4. Writes the ticket's owner and the immutable `Assignment` record together, and clears any `PendingAssignment` row.

`UNIQUE (companyId, ticketId)` is a backstop, not the primary mechanism: if a duplicate insert ever slips through (lock bypassed, or a future multi-instance deploy), the handler re-reads the winning row and returns it as a replay.

A pending outcome writes only `PendingAssignment` — workload and history stay untouched (PRD §4.5). A lock or transaction timeout is never reported as `pending`: `pending` means the rules ran and no agent qualified; a timeout means they never finished running, so it's always `503`.

---

## 7. Coverage Gap Computation

Coverage is computed for a concrete week — Monday 00:00 to the next Monday 00:00, in the company timezone — not generic weekday offsets, since the offset between two timezones can shift across a DST boundary.

1. **Walk every real minute of that week, one instant at a time** — not local-time labels. A label like "Sunday 01:15" is ambiguous during a fall-back transition (two instants share it) and undefined during a spring-forward one (no instant has it). Walking real instants avoids both problems: a fall-back week naturally gets two grid entries for the repeated hour, a spring-forward week naturally gets none for the skipped one.
2. For each instant, evaluate every window with **the same `isWindowActiveAt` check used for assignment** (§3) — one implementation, correct across timezones by construction.
3. Compare against `RequiredSupportHours` for that instant's company-local time.
4. Group consecutive instants that share the identical set of covering agents into `covered`/`gaps` intervals. A gap is any required instant with no covering agent. Intervals are emitted as real timestamps (§5), so two passes of a fall-back hour show up as distinct intervals.

This runs in `O(minutes-in-week × windows × agents)` — trivial at this scale. An interval-based approach would be asymptotically cheaper but adds real complexity for the same DST cases — deferred (§13).

---

## 8. Pending-Assignment Retry Worker

A single interval, started once from `instrumentation.ts` and guarded against dev-mode duplicate timers, fires every five minutes:

- Fetches up to 100 pending tickets, oldest first.
- Re-runs the same assignment transaction as §6 for each — identical rules and idempotency. A ticket already assigned between sweeps is short-circuited, and its pending row is deleted.
- Wraps each call individually, so one failing ticket doesn't block the rest of the batch.

`attemptCount`/`lastAttemptedAt` update every sweep, so the UI can show wait time and attempt count.

Multi-instance is out of scope (§13) — extra instances would just duplicate the work, not break correctness, since §6's lock and idempotency check make repeat sweeps no-ops.

---

## 9. UI Flow

Four pages, three scoped to a company. Plain and functional, per the trial brief.

| Page | Purpose | Key behaviour |
| --- | --- | --- |
| `/` | Company picker | Lists seeded companies, links into their availability page. |
| `/companies/:id/availability` | Manage windows | Weekday table with local times, timezone, agent chips. Overnight windows show a **"↪ ends Tue"** marker. A window with a removed agent shows a **⚠ warning badge** and stays editable. One add/edit dialog, validated with the same Zod schema client- and server-side. |
| `/companies/:id/coverage` | Coverage gaps | 7×24 grid in the company timezone, with gaps also listed as ranges below. On a DST-transition Sunday, the affected hour splits into two stacked cells (one per real pass). |
| `/companies/:id/assignments` | Demo console | Exists so the API is exercisable without curl. **Assign** shows the selected agent, why they were eligible, and the §4.4 explanation; pending shows the reason and per-agent breakdown. A **Run retry sweep now** button hits `POST /api/internal/retry-pending`. |

**Stale response handling.** Fetches on the three company-scoped pages are keyed by `companyId` (and, on coverage, the selected week); a response for a selection the lead has since navigated away from is discarded.

---

## 10. Edge Cases

| # | Case | Behaviour |
| --- | --- | --- |
| 1 | Now is exactly `startMinute` | Available — start-inclusive. |
| 2 | Now is exactly `endMinute` | Not available — end-exclusive. |
| 3 | `start > end` (overnight) | Valid; spills into the following day (§3). |
| 4 | `start === end` | Rejected at validation; never persisted. |
| 5 | Agent is in two overlapping windows | Available; counted once, not summed. |
| 6 | Agent removed after window creation | Excluded from eligibility immediately; window flagged stale in UI. |
| 7 | Every agent in a window is removed | Window contributes no coverage; the gap shows up in the coverage view. |
| 8 | Ticket already assigned | Returns the stored assignee, `idempotent_replay: true`. No workload/history change. |
| 9 | Ticket belongs to another company | `422 TICKET_COMPANY_MISMATCH`. Never assigns cross-company. |
| 10 | Ticket is `RESOLVED`/`CLOSED` | `409 TICKET_TERMINAL`. |
| 11 | No agent available now | `pending` + `NO_AVAILABLE_AGENT`. Only `PendingAssignment` is written. |
| 12 | Agents available, all at limit | `pending` + `ALL_AVAILABLE_AGENTS_AT_CAPACITY`. |
| 13 | `maxActiveTicketsPerAgent = 0` | Everyone always at capacity; always pending. Valid config, not an error. |
| 14 | Company has zero agents | `pending` + `NO_AVAILABLE_AGENT`. |
| 15 | Repeated pending call for one ticket | `PendingAssignment` upserted; `attemptCount` increments; no duplicate rows. |
| 16 | DST spring-forward hour | Window covering only the skipped hour is inactive that day (§3). |
| 17 | DST fall-back hour | Window covering the repeated hour is active across both passes (§3). |
| 18 | Window zone ≠ company support zone | Assignment uses the window's zone; coverage converts to the company zone (§7). |
| 19 | Two concurrent calls, same ticket | Lock serializes; second call is an idempotent replay (§6). |
| 20 | Two concurrent calls, different tickets, one slot left | Serialized per company; the second sees updated workload and either picks another agent or goes pending. |
| 21 | Retry sweep hits a ticket assigned since the last sweep | Existing-assignment check short-circuits; pending row deleted, not reassigned. |
| 22 | Unknown IANA zone submitted | `422 VALIDATION_FAILED` on `timezone`. |
| 23 | Window spans the week boundary (Sun 22:00 – Mon 06:00) | Wraps Sunday→Monday (§3); coverage wraps the same way. |
| 24 | Lock or transaction timeout | `503` with `Retry-After: 5`; never reported as `pending` (§6). |
| 25 | Retry sweep hits a ticket whose evaluation throws | Error logged, that ticket skipped; rest of the batch still runs (§8). |
| 26 | Coverage requested for a past/future week | Same computation with a different `week_start` (§7). |
| 27 | Fall-back week, a window/required-hour inside the repeated hour | Both real passes evaluated independently; a gap in only one pass is still reported (§7). |
| 28 | Spring-forward week | The grid walks the true, shorter elapsed time; the skipped hour contributes no slot (§7). |

---

## 11. Test Plan

Order: unit first (cheap, covers the trickiest rules) → integration happy-path/idempotency (core acceptance criteria) → remaining integration cases → one E2E flow.

**Unit** (no DB, injected `now`) — window evaluation boundaries, overnight/week wraparound, DST both directions; fairness tie-breaks; coverage computation, including a fall-back and a spring-forward week.

**Integration** (real Postgres, per-test rollback) — happy path and explanation payload; idempotency; both pending reasons with correct precedence; retry sweep resolving a pending ticket without double-assigning; concurrent requests for one ticket and for shared capacity; every §5 validation rule; stale-agent exclusion; cross-company isolation; forced timeout returning `503` not `pending`.

**Concurrency regression:** delay one request's transaction (e.g. 2.4s) and fire a second for the same company behind it. Assert the second never starts its transaction until the first has committed or rolled back, and that a caller who times out waiting (`503`) never has a row written for its ticket. This is what catches a lock that races the wait timeout against the transaction itself.

**End-to-end** (Playwright, one flow) — create an availability window → see it with the overnight marker → coverage gap shrinks → demo console assigns a ticket with an explanation shown.

**Seed data** — two companies in different timezones; agents across `Asia/Kolkata`, `Europe/London`, `America/New_York`; an overnight window; a removed agent still referenced by a window; an agent at the limit; a gap in required support hours.

---

## 12. Setup

```bash
docker compose up -d db          # Postgres 16 on :5432
npm install
npx prisma migrate dev           # schema + migrations
npm run seed                     # scenario data (§11)
npm run dev                      # app + API on :3000

npm test                         # vitest: unit + integration
npm run test:e2e                 # playwright
```

---

## 13. Deferred

Out of scope for this trial:

- **Cross-instance coordination.** §6/§8 assume one process. Scaling out needs Postgres advisory locks in place of the in-process lock and sweep guard.
- **Schema-level cross-company enforcement.** Composite FKs would enforce §2's app-level check at the DB too — skipped since this service is the only writer.
- **Denormalized `lastAssignedAt`.** Only worth it once the agent pool is large.
- **Interval-based coverage computation.** Cheaper than §7's per-minute walk, but more code for the same DST cases — not worth it at this scale.
- **Metrics, tracing, dashboards.** Reason codes and the persisted explanation cover "why" for this trial.
- **Staged rollout.** Local only, via `docker compose` + `prisma migrate dev`.
- **Holiday calendars, overrides, fallback owners, escalation.** Excluded by the PRD.
- **Concurrent-editor conflicts on availability windows.** Last-write-wins today; small blast radius, not requested by the PRD.
- **Atomic multi-day window edits.** One `PATCH` per day-row, no cross-row transaction; same reasoning as above.
