# Technical Design: Support Ticket Assignment

Companion to [prd-ticket-assignment-automation.md](prd-ticket-assignment-automation.md). The PRD defines *what* the system does; this document defines *how* it is built — data model, API contracts, algorithms, UI flow, edge cases, and test plan.

---

## 1. Overview

A single Next.js app serves both the availability/coverage UI and the assignment API against a Postgres database via Prisma — one process, one datastore, one `npm run dev` for the reviewer. Route handlers validate input with Zod, delegate to a small set of pure functions for the actual availability/fairness/coverage rules (so the trickiest logic — overnight windows, DST, tie-breaking — is testable in isolation with an explicit `now` instead of `Date.now()`), and persist through a thin transactional layer. The UI calls the same route handlers as any other client, so there's one request path, not two. Luxon handles the timezone-aware time math that availability and coverage depend on.

The trial's FAQ leaves the stack open ("whatever you're most productive in"), so this is a plain statement of what's used rather than a justification for each choice.

---

## 2. Data Model

```prisma
model Company {
  id                        String   @id @default(cuid())
  name                      String
  supportTimezone           String   // IANA, e.g. "Asia/Kolkata"
  maxActiveTicketsPerAgent  Int      // PRD §4.3 shared team limit

  agents              Agent[]
  availabilityWindows AvailabilityWindow[]
  requiredSupportHours RequiredSupportHours[]
  tickets             Ticket[]
}

model Agent {
  id        String    @id @default(cuid())
  companyId String
  name      String
  email     String
  removedAt DateTime? // soft removal -> produces the "stale reference" case in PRD §4.1

  company         Company                   @relation(fields: [companyId], references: [id])
  windowMembers   AvailabilityWindowAgent[]
  assignedTickets Ticket[]                  @relation("TicketAssignee")
  assignments     Assignment[]

  @@index([companyId, removedAt])
}

model AvailabilityWindow {
  id          String  @id @default(cuid())
  companyId   String
  dayOfWeek   Int     // 1 = Monday .. 7 = Sunday (ISO); the day the window STARTS
  startMinute Int     // 0..1439, minutes from local midnight
  endMinute   Int     // 0..1439; endMinute < startMinute => overnight
  timezone    String  // IANA zone the window is authored in
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  company Company @relation(fields: [companyId], references: [id])
  agents  AvailabilityWindowAgent[]

  @@index([companyId, dayOfWeek])
}

model AvailabilityWindowAgent {
  windowId  String
  companyId String  // denormalized for company-scoped queries (§2 modelling notes); not FK-enforced
  agentId   String

  window AvailabilityWindow @relation(fields: [windowId], references: [id], onDelete: Cascade)
  agent  Agent              @relation(fields: [agentId], references: [id])

  @@id([windowId, agentId])
  @@index([companyId, agentId])
}

model RequiredSupportHours {
  id          String @id @default(cuid())
  companyId   String
  dayOfWeek   Int    // 1 = Monday .. 7 = Sunday (ISO), same convention as AvailabilityWindow
  startMinute Int
  endMinute   Int    // interpreted in company.supportTimezone (PRD §4.2); endMinute < startMinute is overnight, masked with the same wraparound rule as §3

  company Company @relation(fields: [companyId], references: [id])
  @@index([companyId])
}

model Ticket {
  id          String       @id @default(cuid())
  companyId   String
  status      TicketStatus @default(OPEN)
  assigneeId  String?
  assignedAt  DateTime?

  company    Company             @relation(fields: [companyId], references: [id])
  assignee   Agent?              @relation("TicketAssignee", fields: [assigneeId], references: [id])
  assignment Assignment?
  pending    PendingAssignment?

  @@index([assigneeId, status])            // active workload count
  @@index([companyId, status])
}

enum TicketStatus { OPEN IN_PROGRESS WAITING RESOLVED CLOSED }
// Terminal = RESOLVED | CLOSED. Everything else counts toward active workload.

model Assignment {
  id          String   @id @default(cuid())
  companyId   String
  ticketId    String   @unique             // required for the Ticket.assignment 1:1 back-relation
  agentId     String
  assignedAt  DateTime @default(now())
  explanation Json     // PRD §4.6 payload, persisted so the decision is auditable

  ticket Ticket @relation(fields: [ticketId], references: [id])
  agent  Agent  @relation(fields: [agentId], references: [id])

  @@unique([companyId, ticketId])          // the idempotency guarantee, PRD §4.5
  @@index([agentId, assignedAt])           // "least recently assigned" tie-break
}

model PendingAssignment {
  companyId        String
  ticketId         String   @unique        // required for the Ticket.pending 1:1 back-relation
  reasonCode       String   // NO_AVAILABLE_AGENT | ALL_AVAILABLE_AGENTS_AT_CAPACITY
  firstRequestedAt DateTime @default(now())
  lastAttemptedAt  DateTime @default(now())
  attemptCount     Int      @default(1)

  ticket Ticket @relation(fields: [ticketId], references: [id])

  @@id([companyId, ticketId])
  @@index([lastAttemptedAt])
}
```

### Modelling notes

**Times as `Int` minutes, not `TIME`.** `startMinute`/`endMinute` are minutes from local midnight (0–1439). Comparison, overnight detection, and coverage-mask arithmetic all become plain integer math, and there is no risk of a driver silently attaching a date or zone to a `TIME` value. The UI renders them as `HH:mm`.

**One window, many days, many agents.** The PRD lets a lead pick several weekdays and several agents in one form. Multiple weekdays are persisted as one `AvailabilityWindow` row *per day* (created in a single transaction, sharing a `createdAt`), because each day is independently editable and independently evaluated. Agents are a join table so a window can be edited without touching agent rows.

**`Agent.removedAt` rather than hard delete.** Removing an agent leaves its `AvailabilityWindowAgent` rows intact. That is precisely the stale-reference state the PRD asks the UI to flag: the window still lists the agent, the agent is no longer eligible. A hard delete would cascade the join rows away and the lead would never learn their schedule now has a hole.

**No denormalized `lastAssignedAt` on `Agent`.** It is derived from `MAX(Assignment.assignedAt)` per agent, covered by the `(agentId, assignedAt)` index. One source of truth; a denormalized column could drift from the assignment history it is supposed to summarize. If the candidate set ever grew past a few hundred agents this is the first thing to cache.

**`Assignment` is separate from `Ticket.assigneeId`.** `Ticket` carries the current owner (and is what workload counts read); `Assignment` is the immutable decision record that carries the unique constraint, the explanation, and the fairness history. Keeping them apart means a future manual reassignment can update the ticket without rewriting history.

**`ticketId` carries its own `@unique`, alongside the composite keys.** `Ticket.assignment`/`Ticket.pending` are declared as optional single values, not arrays, which is a promise Prisma can only enforce if the referenced scalar (`ticketId`) is independently unique — `@@unique([companyId, ticketId])` and `@@id([companyId, ticketId])` don't satisfy that on their own, since Prisma doesn't infer single-column uniqueness from a composite one. This adds no new business rule: a ticket belongs to exactly one company by construction, so `ticketId` was already a de facto unique key. The composite keys stay, since the application deliberately queries by `(companyId, ticketId)` as a company-scoping check (§6), not only as an idempotency key.

**Cross-company integrity is an application-level check, not a schema-level one.** Every write path validates `agent.companyId === company.id` (and the equivalent for tickets) before it does anything else (§4.2, edge case 9) — that is what the acceptance criteria and the integration tests actually exercise. A composite `[companyId, id]` foreign key on every relation would make the same mistake impossible at the database level too, which starts to matter once other services write to this data. For this trial the assignment service is the only writer (PRD §5), so that extra structural layer is deferred (§13) rather than built now.

**Seed data is assumed internally consistent.** Tickets and their history may arrive as fixtures (PRD §5); the design assumes a seeded `Ticket.assigneeId` always agrees with its corresponding `Assignment` row, since the same seed script controls both. Reconciling a deliberately inconsistent fixture is out of scope for the trial.

---

## 3. Availability Evaluation

Windows are stored exactly as authored — local weekday, local times, IANA zone — and evaluated by projecting the query instant into each window's own zone. Nothing is precomputed into UTC, so a DST transition needs no migration and editing a window is a single row write.

```ts
// pure function — no I/O, `now` injected
export function isWindowActiveAt(w: WindowSpec, now: DateTime): boolean {
  const local = now.setZone(w.timezone);
  const dow = local.weekday;                    // 1..7, ISO
  const min = local.hour * 60 + local.minute;

  if (w.startMinute < w.endMinute) {
    // same-day window: [start, end)
    return dow === w.dayOfWeek && min >= w.startMinute && min < w.endMinute;
  }
  // overnight window: [start, midnight) on dayOfWeek, then [midnight, end) on the next day
  const nextDay = (w.dayOfWeek % 7) + 1;
  return (dow === w.dayOfWeek && min >= w.startMinute)
      || (dow === nextDay      && min <  w.endMinute);
}
```

Start-inclusive / end-exclusive (`>= start`, `< end`) is applied in both branches, so a 09:00–17:00 window is active at exactly 09:00:00 and inactive at exactly 17:00:00 — matching PRD §4.1.

`startMinute === endMinute` is rejected at validation, so it never reaches this function. That keeps the two branches exhaustive: there is no "zero-length or 24-hour?" ambiguity to resolve at read time.

### DST semantics

A window is a **wall-clock** schedule: "Mondays 22:00–06:00, Europe/London" means whatever the clock on the wall in London says, on every Monday, forever.

- **Spring forward.** Local times in the skipped hour never occur, so a window covering only that hour is simply inactive that day. A window spanning it is one hour shorter in absolute terms.
- **Fall back.** The repeated hour occurs twice, so a window covering it is active for both passes — one hour longer in absolute terms.

This is the behaviour a team lead expects (a 9-to-5 shift is 9-to-5 regardless of DST) and it falls out of the algorithm for free, because `setZone` resolves the wall clock for us. It is called out here because it is the main thing precomputed-UTC-interval designs get wrong.

`now` is always injected as a parameter, never read from `Date.now()` inside domain code — that is what makes DST boundaries testable as plain assertions.

---

## 4. Assignment Algorithm

### 4.1 Candidate gathering

One query per company, scoped tightly: every non-removed agent of that company, each paired with a count of their active tickets (status not `RESOLVED`/`CLOSED`) and the timestamp of their most recent assignment, if any. Both are aggregates over `Ticket` and `Assignment` grouped by agent, so this is a single round trip rather than N+1 lookups.

Availability windows for the company are loaded alongside (with their agent join rows) and evaluated in memory by §3. The candidate set for a single company is small enough that filtering in application code — where the DST-correct logic already lives and is unit-tested — beats pushing timezone arithmetic into SQL.

### 4.2 Eligibility filter (PRD §4.3)

An agent is eligible when all three hold:

1. `agent.companyId === company.id && agent.removedAt === null`
2. at least one of the company's windows containing that agent satisfies `isWindowActiveAt(window, now)`
3. `activeCount < company.maxActiveTicketsPerAgent`

Failing agents are retained with a rejection reason (`UNAVAILABLE`, `AT_CAPACITY`, `REMOVED`) — this is what lets the API explain a pending result precisely rather than guessing.

### 4.3 Fairness ranking (PRD §4.4)

```ts
// total order, no ties possible at the end
eligible.sort((x, y) =>
     x.activeCount - y.activeCount                    // 1. fewest active tickets
  || cmpNullsFirst(x.lastAssignedAt, y.lastAssignedAt) // 2-3. least recently assigned;
                                                       //      never-assigned ranks first
  || x.id.localeCompare(y.id)                          // 4. deterministic tie-break
);
```

`cmpNullsFirst` treats `null` (never assigned) as earlier than any timestamp, which gives PRD rule 3 without a special case. The `id` comparison is a determinism device, not a fairness signal — it is the last key so it only ever breaks exact ties, and it is what makes a test able to assert a single expected winner.

### 4.4 Explanation (PRD §4.6)

The decisive rule is identified by comparing the winner to the runner-up on each key in order — the first key on which they differ is the rule that decided it:

```jsonc
{
  "selected_agent": { "id": "agt_7", "name": "Priya" },
  "eligibility": {
    "available_via_window": { "id": "win_3", "day": "MON", "local": "09:00-17:00", "timezone": "Asia/Kolkata" },
    "active_tickets": 2,
    "limit": 5
  },
  "decided_by": "FEWEST_ACTIVE_TICKETS",     // or LEAST_RECENTLY_ASSIGNED | NEVER_ASSIGNED | AGENT_ID_TIEBREAK
  "runner_up": { "id": "agt_2", "active_tickets": 3 },
  "considered": [
    { "agent_id": "agt_2", "eligible": true,  "active_tickets": 3 },
    { "agent_id": "agt_9", "eligible": false, "reason": "AT_CAPACITY", "active_tickets": 5 },
    { "agent_id": "agt_4", "eligible": false, "reason": "UNAVAILABLE" }
  ]
}
```

If there is no runner-up, `decided_by` is `ONLY_ELIGIBLE_AGENT`. The whole object is persisted to `Assignment.explanation`, so a lead can answer "why them?" weeks later, not just at the moment of the call.

---

## 5. API

All responses share one envelope. Errors:

```jsonc
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [ ... ] } }
```

### `POST /api/assignments`

```jsonc
// request
{ "company_id": "cmp_1", "ticket_id": "tkt_42" }
```

`POST`, not `GET`: the call establishes a durable assignment decision. It is idempotent rather than safe, which the `UNIQUE (companyId, ticketId)` constraint enforces (§6).

**200 — assigned** (first call, or any repeat call for an already-assigned ticket):

```jsonc
{
  "status": "assigned",
  "ticket_id": "tkt_42",
  "assignee": { "id": "agt_7", "name": "Priya", "email": "priya@acme.com" },
  "assigned_at": "2026-09-20T09:14:03.118Z",
  "idempotent_replay": false,        // true when returning a previously stored decision
  "explanation": { /* §4.4 */ }
}
```

**200 — pending** (PRD §4.7 — deliberately not an error; the caller asked a valid question and got a valid answer):

```jsonc
{
  "status": "pending",
  "ticket_id": "tkt_42",
  "reason": "ALL_AVAILABLE_AGENTS_AT_CAPACITY",
  "message": "3 agents are available, all at the 5-ticket limit.",
  "next_retry_at": "2026-09-20T09:19:03.118Z",
  "considered": [ /* per-agent rejection reasons */ ]
}
```

| Code | Condition |
| --- | --- |
| `NO_AVAILABLE_AGENT` | No agent of the company is inside an active window right now. |
| `ALL_AVAILABLE_AGENTS_AT_CAPACITY` | At least one agent is available; every one is at the limit. |

Precedence: if *any* agent is available, the reason is the capacity one — that points the lead at the more actionable problem.

Errors: `422 VALIDATION_FAILED` (malformed `company_id`/`ticket_id`), `404 COMPANY_NOT_FOUND`, `404 TICKET_NOT_FOUND`, `422 TICKET_COMPANY_MISMATCH` (ticket belongs to a different company), `409 TICKET_TERMINAL` (ticket is already `RESOLVED`/`CLOSED`), `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` (lock or transaction timeout).

`503` is never used interchangeably with `pending`: one means the rules were fully evaluated and no agent qualified, the other means evaluation didn't complete at all (§6) — collapsing them would tell whoever's watching a ticket "no one is available" when the truth is "the database didn't respond in time."

### Availability CRUD

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/companies/:companyId/availability-windows` | Returns windows with agents, each agent flagged `is_stale` when `removedAt !== null`. |
| `POST` | `/api/companies/:companyId/availability-windows` | Body accepts `days_of_week: number[]`; creates one row per day in one transaction. |
| `PATCH` | `/api/availability-windows/:windowId` | Full replace of times/zone/agents for that one day-row. |
| `DELETE` | `/api/availability-windows/:windowId` | Cascades the join rows. |

Create/update body:

```jsonc
{
  "days_of_week": [1, 2, 3],
  "start_time": "22:00",
  "end_time": "06:00",
  "timezone": "Asia/Kolkata",
  "agent_ids": ["agt_7", "agt_2"]
}
```

Validation (PRD §4.1) — all `422 VALIDATION_FAILED` with a per-field `details` array the form renders inline:

| Rule | Check |
| --- | --- |
| Known timezone | `Info.isValidIANAZone(timezone)` |
| Times present and well-formed | `/^([01]\d|2[0-3]):[0-5]\d$/` |
| Start ≠ end | `startMinute !== endMinute` |
| At least one agent | `agent_ids.length > 0` |
| Agents belong to the company | every id resolves to a non-removed agent with matching `companyId` |
| Days present and valid | non-empty, each in 1–7 |

`endMinute < startMinute` is explicitly **allowed** — it is the overnight case.

### `GET /api/companies/:companyId/coverage?week_start=YYYY-MM-DD`

Returns the coverage picture for the Monday-starting week containing `week_start`, already projected into the company support timezone (§7). `week_start` is optional and defaults to the current week; a value that isn't a valid date returns `422 VALIDATION_FAILED`.

```jsonc
{
  "timezone": "Asia/Kolkata",
  "week_start": "2026-09-14T00:00:00+05:30",
  "week_end":   "2026-09-21T00:00:00+05:30",
  "required":  [ { "day_of_week": 1, "start": "2026-09-14T09:00:00+05:30", "end": "2026-09-14T18:00:00+05:30" } ],
  "covered":   [ { "day_of_week": 1, "start": "2026-09-14T09:00:00+05:30", "end": "2026-09-14T13:00:00+05:30", "agent_ids": ["agt_7"] } ],
  "gaps":      [ { "day_of_week": 1, "start": "2026-09-14T13:00:00+05:30", "end": "2026-09-14T18:00:00+05:30", "duration_minutes": 300 } ],
  "total_gap_minutes": 300
}
```

`start`/`end` on every interval (`required`, `covered`, `gaps`) are full ISO-8601 instants with offset, not bare `HH:mm` — `day_of_week` is kept alongside purely for display/grouping convenience, but the timestamps are authoritative (§7). This is what lets a fall-back week represent both passes of a repeated local hour distinctly: a New York company requiring Sunday 01:00–02:00 local on 2026-11-01 gets two `required` entries, `2026-11-01T01:00:00-04:00`–`T02:00:00-04:00` (EDT, first pass) and `...T01:00:00-05:00`–`T02:00:00-05:00` (EST, second pass) — identical `day_of_week` and `HH:mm`, distinct real intervals, each checked for coverage independently.

### `GET /api/companies/:companyId/agents`

Agents with `active_ticket_count`, `is_available_now`, `removed_at`. Feeds the agent picker and the demo console.

### `POST /api/internal/retry-pending`

Runs one pending-assignment sweep synchronously and returns what changed. Exists so the retry path is testable without waiting five minutes or stubbing timers, and so the demo console can show a retry resolving live.

```jsonc
{ "swept": 4, "assigned": 1, "still_pending": 3 }
```

---

## 6. Concurrency and Idempotency

Two distinct races have to be closed.

**Race A — the same ticket assigned twice.** Two concurrent `POST /api/assignments` for one ticket could both find no existing assignment and both insert.

**Race B — capacity overshoot.** Two concurrent calls for *different* tickets of the same company both read agent X at 4 active tickets under a limit of 5, and both pick X. X ends at 6.

Both races are closed with an **in-process lock keyed by `companyId`** — correct as long as the app runs single-process, which is this trial's scope (§13 covers the assumption and the multi-instance fix).

The queue-wait timeout and the transaction timeout bound two different phases and must not be merged into one race: the wait timeout governs only how long a caller sits behind a prior holder, and it must never allow `work` to start once it has fired; the queue's own tail must only advance once `work` has actually settled (commit or rollback), not when a caller's own wait gives up on it — otherwise a slow transaction and a timed-out waiter can run concurrently, which is exactly the capacity race this lock exists to close.

```ts
// one FIFO queue per company
const queues = new Map<string, Promise<unknown>>();

export function withCompanyLock<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(companyId) ?? Promise.resolve();
  const priorSettled = prior.then(() => {}, () => {});   // real completion, win or lose

  // Bounds only the WAIT for the previous holder — never `work` itself.
  const waitTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new LockTimeoutError()), 2_000));

  // Resolves once it's genuinely this caller's turn; rejects, without ever
  // touching `work`, if the wait budget expires first.
  const acquired = Promise.race([priorSettled, waitTimeout]);

  // The one and only invocation of `work`, gated on actually acquiring the turn.
  const result = acquired.then(() => work());

  // The new queue tail: if we acquired, the lock is held until `work` truly
  // settles — not until the wait race settles. If we timed out waiting,
  // `work` never ran, so the tail forwards unchanged to `priorSettled`: the
  // next caller still waits on the transaction that's actually still running,
  // never on us.
  queues.set(companyId, acquired.then(
    () => result.then(() => {}, () => {}),
    () => priorSettled,
  ));

  return result;
}
```

```ts
// the assignment use-case, wrapped by the lock above
await withCompanyLock(companyId, () =>
  prisma.$transaction(async (tx) => {
    // 1. inside the lock, a prior decision is authoritative (PRD §4.5)
    const existing = await tx.assignment.findUnique({ where: { companyId_ticketId: { companyId, ticketId } } });
    if (existing) return replay(existing);          // idempotent_replay: true

    // 2. the ticket must belong to the requested company and still be open
    const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (ticket.companyId !== companyId) return mismatch();   // 422 TICKET_COMPANY_MISMATCH
    if (isTerminal(ticket.status)) return terminal();        // 409 TICKET_TERMINAL

    // 3. read candidates, evaluate, decide — all reads now see a stable world
    const decision = decide(await loadCandidates(tx, companyId), now);
    if (!decision.agent) return upsertPending(tx, decision);

    // 4. write ticket owner + immutable decision record together
    await tx.ticket.update({ where: { id: ticketId }, data: { assigneeId: decision.agent.id, assignedAt: now } });
    await tx.assignment.create({ data: { companyId, ticketId, agentId: decision.agent.id, explanation: decision.explanation } });
    await tx.pendingAssignment.deleteMany({ where: { ticketId } });
    return assigned(decision);
  }, { timeout: 5_000 })
);
```

The lock is keyed on `companyId`, not the ticket, because it closes race B: capacity is a property shared across the company's tickets, so the whole decision must be serialized at company granularity. It closes race A as a side effect, since the existing-assignment check now always runs against a stable world.

The `UNIQUE (companyId, ticketId)` constraint remains as a **backstop**, not the primary mechanism: if a unique violation (`23505`) ever surfaces — the in-process lock was bypassed, or a future deploy runs more than one instance — the handler re-reads the winning row and returns it as an idempotent replay. Correct behaviour even if the lock is bypassed.

Cost: assignments for one company are serialized within the process. For a support team's ticket volume that is irrelevant, and it buys exact capacity enforcement with no database-specific locking primitive to reason about. Different companies never contend. Scaling to more than one instance is out of scope for this trial — see §13 for the limitation and its fix.

A pending outcome writes only `PendingAssignment` — no ticket update, no `Assignment` row — so an unsuccessful attempt leaves workload and assignment history untouched, exactly as PRD §4.5 requires.

**A lock or transaction timeout is not a pending outcome.** The wait and the transaction are sequential, not raced against each other, and each carries its own finite timeout: up to 2s waiting for a prior holder to finish (during which `work` — and therefore the transaction — has not started at all), then up to 5s once the transaction itself is running. If either fires, `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` is returned — never `pending`. `pending` means the rules were evaluated and no agent qualified; a timeout means the rules were never fully evaluated. Because `work` only ever starts after the wait is won, a request that times out waiting is guaranteed to never have touched the database — there is nothing for that request to roll back.

---

## 7. Coverage Gap Computation

Gaps are computed against a **concrete reference week** (Monday 00:00 in the company support timezone through the following Monday 00:00), not abstract weekday offsets — coverage is date-specific because the offset between the company's zone and any window's zone can shift week to week (DST doesn't move on the same calendar date everywhere). The week anchors are `weekStart = DateTime.fromISO(week_start, { zone: company.supportTimezone }).startOf('week')` and `weekEnd = weekStart.plus({ weeks: 1 })`. Both use Luxon's default DST resolution as-is (round a nonexistent local time forward, keep the first pass of a repeated one) rather than a bespoke resolver — a company's local midnight landing inside a DST transition is rare enough that a special-case resolver isn't worth building for the trial. `plus({ weeks: 1 })` is calendar-aware, so `weekEnd` always lands on the correct following Monday 00:00 regardless of any DST shift inside the week — but the *elapsed real time* between the two anchors, which is what the grid below actually walks, is then 10,080 minutes only when the week contains no transition. The API's `week_start` parameter (§5) picks which week, defaulting to the current one — only the anchors change; the computation below is identical regardless of which week is requested.

The grid walks **real one-minute instants** from `weekStart` to `weekEnd` — `weekStart.plus({ minutes: i })` for `i` in `0 .. weekEnd.diff(weekStart, 'minutes').minutes`, added as an exact duration, not re-resolved as a local wall-clock label. That distinction matters: converting a *local label* like "Sunday 01:15" back to a real instant is ambiguous during a fall-back transition (two real instants share that label) and undefined during a spring-forward one (no real instant has that label). A grid built by enumerating labels first and resolving them second silently collapses a fall-back hour onto whichever pass the DST-resolution rule picks — dropping the other pass's coverage check entirely, along with any gap that exists only in that pass. Walking real instants forward avoids the ambiguity instead of resolving it: each `i` names one distinct instant, so a fall-back week naturally produces two grid entries for the repeated local hour and a spring-forward week naturally produces none for the skipped one — no special-casing required. For each instant, evaluate every company window against it with **the exact same `isWindowActiveAt` predicate used for assignment** (§3) — not a second implementation of the day/timezone logic — collecting the sorted, deduped IDs of every non-removed agent whose window is active at that instant. A window with only removed agents naturally contributes nothing to any slot.

Reusing `isWindowActiveAt` is what makes the cross-timezone case correct by construction: a window authored in `America/New_York` is resolved independently, in its own zone, from that slot's one real instant — including moments where New York's calendar date differs from the company's. A design that instead precomputes a fixed offset between the two zones can get this wrong by exactly one day near a DST transition; this design never computes an offset at all.

Required hours (`RequiredSupportHours`, already authored in the company timezone, same overnight rule as §3) are evaluated against the same real instants — converting an unambiguous real instant to the company's local wall-clock time to check the required-hours mask is always well-defined, unlike the reverse direction the grid above deliberately avoids. `covered` and `gaps` both come from grouping consecutive instants that share an identical value — grouping by the *set* of covering agents, not just covered/not, so a handoff from one agent's window to another's yields two adjacent intervals with distinct `agent_ids` rather than one interval with ambiguous attribution; a gap is any required instant whose covering set is empty. Each grouped interval's `start`/`end` is emitted as the real ISO-8601 instant, not a bare `HH:mm` (§5): two passes of a fall-back local hour can end up as two separate, adjacent intervals with different coverage, and only an offset-bearing timestamp can tell them apart on the wire — a plain weekday-plus-time pair cannot.

Complexity is `O(minutes-in-the-week × windows × agents-per-window)` — trivial, and independent of how far apart the zones involved are or of the ±60-minute change a DST-transition week makes to the instant count.

---

## 8. Pending-Assignment Retry Worker

A single interval, started once from `instrumentation.ts` (Next.js's server-init hook) and guarded by a module-level flag so dev-mode hot reload can't stack duplicate timers, fires every five minutes and sweeps due work:

- Fetch up to 100 `PendingAssignment` rows, oldest `lastAttemptedAt` first.
- For each, call `assignTicket(companyId, ticketId)` — the exact same transactional use-case from §6, not a parallel implementation. That's what guarantees a retry applies the same availability, workload, and fairness rules, and inherits the same idempotency: a ticket assigned between sweeps is short-circuited by the existing-assignment check and its `PendingAssignment` row is deleted, so it's never assigned twice (PRD §4.7).
- Each call is wrapped individually: one ticket throwing — a transient DB error, a lock timeout — is logged and skipped rather than aborting the sweep. Without that isolation, a single persistently-failing ticket sorted to the front of the batch would block the other 99 behind it every five minutes.

Multi-instance is out of scope here too (§13) — worth noting for this worker specifically: running N instances wouldn't break correctness, since the §6 lock and existing-assignment check turn the extra sweeps into no-ops, just duplicate the work N times over.

`attemptCount` and `lastAttemptedAt` are updated on every sweep, so the UI can show how long a ticket has been waiting and how many times it has been tried.

---

## 9. UI Flow

Four pages, three scoped to a company. Plain and functional, per the trial brief.

| Page | Purpose | Key behaviour |
| --- | --- | --- |
| `/` | Company picker | Lists seeded companies, links into their availability page. No create/switch logic — just a read of seed data, so a reviewer isn't stuck typing a `companyId` into the URL bar. A real multi-tenant product resolves the company from the session instead. |
| `/companies/:id/availability` | Manage windows | Table grouped by weekday: local times, timezone, agent chips. Overnight windows carry an explicit **"↪ ends Tue"** marker — a lead reading `22:00–06:00` needs to be told which day it lands on. An agent-removed window shows a **⚠ warning badge** and a row tint (PRD §4.1) but stays editable — the point is to prompt correction, not hide the problem. Add/edit is one dialog (weekday multi-select, start/end time, searchable IANA timezone, agent multi-select); the same Zod schema validates client-side for instant feedback and server-side as the real gate. |
| `/companies/:id/coverage` | Coverage gaps | 7×24 grid (hour cells, minute-resolution data underneath) in the company support timezone, with a banner stating that timezone explicitly. Gaps are also listed below the grid as explicit ranges with durations. On the two Sundays a year the company's zone observes a DST transition, the affected hour's cell expands to two stacked cells (one per real pass) instead of silently picking one — consistent with the API's offset-bearing intervals (§7). |
| `/companies/:id/assignments` | Demo console | Not production — exists so the API is exercisable without curl. **Assign** shows the selected agent, the window that made them available, workload vs. limit, and the §4.4 explanation as prose; a pending result shows the reason and per-agent breakdown. A **Run retry sweep now** button hits `POST /api/internal/retry-pending` so the retry path is demonstrable in seconds. |

**Stale response handling.** The three company-scoped pages key their fetches by `companyId` (and, on coverage, the selected week); a response tagged for a selection the lead has since navigated away from is discarded rather than rendered. Without this, a slow response for company A landing after the lead switches to company B would briefly render A's data under B's name.

---

## 10. Edge Cases

| # | Case | Behaviour |
| --- | --- | --- |
| 1 | Now is exactly `startMinute` | Available — start-inclusive. |
| 2 | Now is exactly `endMinute` | Not available — end-exclusive. |
| 3 | `start > end` (overnight) | Valid; spills into the following day (§3). |
| 4 | `start === end` | Rejected at validation; never persisted. |
| 5 | Agent is in two overlapping windows | Available; counted once. Windows are OR-ed, not summed. |
| 6 | Agent removed after window creation | Excluded from eligibility immediately; window flagged stale in UI. |
| 7 | Every agent in a window is removed | Window contributes no coverage; the gap appears in the coverage view. |
| 8 | Ticket already assigned | Returns the stored assignee with `idempotent_replay: true`. No workload or history change. |
| 9 | Ticket belongs to another company | `422 TICKET_COMPANY_MISMATCH`. Never assigns cross-company. |
| 10 | Ticket is `RESOLVED`/`CLOSED` | `409 TICKET_TERMINAL`. |
| 11 | No agent available now | `pending` + `NO_AVAILABLE_AGENT`. Nothing written but `PendingAssignment`. |
| 12 | Agents available, all at limit | `pending` + `ALL_AVAILABLE_AGENTS_AT_CAPACITY`. |
| 13 | `maxActiveTicketsPerAgent = 0` | Everyone is always at capacity; always pending. Valid configuration, not an error. |
| 14 | Company has zero agents | `pending` + `NO_AVAILABLE_AGENT`. |
| 15 | Repeated pending call for one ticket | `PendingAssignment` upserted; `attemptCount` increments; no duplicate rows (`ticketId` is the PK). |
| 16 | DST spring-forward hour | Window covering only the skipped hour is inactive that day (§3). |
| 17 | DST fall-back hour | Window covering the repeated hour is active across both passes (§3). |
| 18 | Window zone ≠ company support zone | Assignment uses the window's zone; coverage converts into the company zone (§7). |
| 19 | Two concurrent calls, same ticket | In-process lock serializes; second is an idempotent replay. Unique constraint as backstop (§6). |
| 20 | Two concurrent calls, different tickets, one slot left | Serialized per company; the second sees updated workload and either picks another agent or goes pending. Limit is never exceeded. |
| 21 | Retry sweep hits a ticket assigned since the last sweep | Existing-assignment check short-circuits; `PendingAssignment` deleted. Not reassigned. |
| 22 | Unknown IANA zone submitted | `422 VALIDATION_FAILED` on the `timezone` field. |
| 23 | Window spans the week boundary (Sun 22:00 – Mon 06:00) | Evaluation wraps Sunday→Monday via `(dayOfWeek % 7) + 1`; coverage wraps modulo 10080. |
| 24 | Lock or transaction timeout during assignment | `503 SERVICE_UNAVAILABLE` with `Retry-After: 5`; never reported as `pending` (§6). |
| 25 | Retry sweep hits a ticket whose evaluation throws | Error logged, that ticket skipped this pass; the rest of the batch still runs (§8). |
| 26 | Coverage requested for a past or future week | Same computation with a different `week_start`; anchors resolved per §7, including across a DST week boundary. |
| 27 | Fall-back week, required hours or an agent window falling inside the repeated local hour | Both real passes are walked and evaluated independently (§7); a gap present in only one pass is reported, never hidden by the other. |
| 28 | Spring-forward week | The grid walks the true, shorter elapsed real time for that week; the skipped local hour contributes no slot in either direction (§7). |

---

## 11. Test Plan

Given the trial's time budget, unit tests come first (cheap, no infra, cover the trickiest rules), then the integration happy-path and idempotency cases (the PRD's core acceptance criteria), then the remaining integration cases and the one E2E flow.

### Unit (fast, no DB, injected `now`)

Covers the pure logic in isolation: availability window evaluation (boundary inclusivity, overnight and week-boundary wraparound, cross-timezone evaluation, DST spring-forward/fall-back), fairness ranking (each tie-break rule in order, plus the empty-eligible-set case), and coverage gap computation (partial coverage, removed-agent windows, multi-agent handoffs, and week-anchoring including DST edge cases — specifically a mixed-zone fall-back week where an agent's window covers only one of the two real passes of a repeated required-hours label, asserting the gap in the uncovered pass is reported and not hidden by the covered one, and a spring-forward week, asserting the grid walks one fewer real hour rather than fabricating a slot for the skipped one).

### Integration (real Postgres, per-test transaction rollback)

Covers the assignment API's actual guarantees end to end: the happy path and its explanation payload; idempotency on repeat calls; both pending reasons (no availability vs. at capacity) with correct precedence; the retry sweep resolving a pending ticket without double-assigning one already resolved; concurrent calls racing for one ticket and for shared capacity (verifying the in-process lock, §6); validation of every rule in §5; stale-agent exclusion; cross-company isolation; and a forced lock/transaction timeout returning `503` rather than `pending`.

A dedicated concurrency regression, not just a status-code assertion: hold one request's `work` open with an injected delay (e.g. 2.4s, inside the 5s transaction budget) and fire a second request for the same company behind it. Assert the second request's `work` is never invoked until the first's transaction has actually committed or rolled back — not merely that both calls eventually return — and, for a caller whose wait exceeds the 2s budget and gets `503`, assert no `Assignment`/`Ticket` row is ever written for that caller's ticket afterward. This is what catches a lock implementation that races the wait timeout against `work` itself instead of gating `work` on actually acquiring the turn (§6).

### End-to-end — Playwright, one flow

Create an availability window → see it in the list with the overnight marker → open the coverage page and see the gap shrink → open the demo console, assign a ticket, and read the explanation.

One E2E test, kept deliberately narrow: it proves the pages are wired to the API, while the behavioural depth lives in the unit and integration layers where it is cheap and stable.

### Seed data

`prisma/seed.ts` builds a scenario that makes every interesting case reachable by hand: two companies in different support timezones, agents spread across `Asia/Kolkata`, `Europe/London`, and `America/New_York`, at least one overnight window, one removed agent still referenced by a window, one agent parked at the active-ticket limit, and a deliberate hole in required support hours so the coverage view has something to show on first load.

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

Out of scope for this trial, listed so the boundary is explicit rather than implied:

- **Cross-instance coordination.** Both the retry sweep (§8) and the assignment lock (§6) assume a single process, which is what the trial runs. Scaling past one instance needs a `pg_try_advisory_lock` guard around the sweep and a `pg_advisory_xact_lock` in place of `withCompanyLock` (§6) — the same primitive, applied to both paths consistently, rather than solved for one and merely accepted as a limitation for the other.
- **Schema-level cross-company enforcement.** Cross-company writes are rejected in application code today (§2, §4.2, edge case 9); composite `[companyId, id]` foreign keys would make the same mistake impossible at the database level too. Not built because the assignment service is the only writer for this trial (PRD §5).
- **Denormalized `lastAssignedAt`.** Only worthwhile once the candidate set is large (§2).
- **Interval/sweep-line coverage computation.** §7 walks every real minute of the week (~10,080, ±60 across a DST transition) rather than computing each window's real occurrences as intervals and merging them. The interval approach is asymptotically cheaper — O(events) instead of O(minutes) — but at this trial's scale both run in milliseconds, and interval math (overnight wraparound, weekly recurrence, and the same DST-fold expansion §7 already has to get right, just relocated to per-window interval construction) is meaningfully more code and more ways to reintroduce the exact class of bug §7 was just fixed for. Worth revisiting only if the number of companies/windows/agents grows enough that per-minute evaluation stops being trivial.
- **Metrics, tracing, dashboards.** The observability surface for this trial is reason codes (§5) and the persisted `Assignment.explanation` (§4.4) — enough to answer "why" from the code or the data, not enough to page anyone. No metrics pipeline is built.
- **Staged rollout.** Single local environment via `docker compose` + `prisma migrate dev` (§12); no deployment target, feature flags, or blue-green path — the trial explicitly doesn't call for hosting.
- **Holiday calendars, one-off overrides, fallback owners, escalation.** Excluded by the PRD.
- **Concurrent-editor conflicts on availability windows.** Two people (or two tabs) editing the same window at once currently resolve last-write-wins on `PATCH`. Not caused by the trial's no-auth setup — the same race exists with real logins, since it's two writers, not zero identity. Left out because the PRD doesn't ask for it and the blast radius is small (a lead redoing an edit), unlike the assignment path, which already gets an idempotency guarantee (§6) because incorrect ticket assignment has real customer impact. A production version would add an `updatedAt`-based version check on `PATCH`, returning `409 CONFLICT` with the current row instead of silently overwriting.
- **Atomic multi-day window edits.** A window spanning several weekdays persists as one row per day (§2); editing it issues one `PATCH` per day-row with no transaction across them, so a request that fails partway through can leave days inconsistent. Left out for the same reason as the concurrent-editor conflict above: the PRD doesn't ask for it, and the blast radius is a lead re-editing one day.
