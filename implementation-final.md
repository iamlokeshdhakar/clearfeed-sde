# Implementation Plan: Support Ticket Assignment

Use one Next.js application for the UI and API, PostgreSQL with Prisma for storage, Zod for validation, and Luxon for timezone handling. Route handlers call a shared assignment service; availability, ranking, and coverage calculations are pure functions with an explicit time input.

Each assignment runs in a transaction under a company queue: load candidates, select an agent, then save ownership and the decision together. If no agent qualifies, the requested ticket remains pending for the five-minute retry worker. The trial runs in one Node.js process.

The [PRD](prd-ticket-assignment-automation.md) defines product scope and requirements. This document covers implementation, contracts, edge cases, and validation.

## 1. Assignment request flow

`POST /api/assignments` accepts `company_id` and `ticket_id`. Validate the input, acquire the company queue, and run one transaction:

1. Look up the saved assignment by company and ticket. If found, return it as an idempotent replay and remove any leftover pending row.
2. Otherwise, check that the company and ticket exist, the ticket belongs to the company, and its status is non-terminal. If it is terminal with no saved assignment, delete any existing pending row for it, commit, and return `409 TICKET_TERMINAL`; a terminal ticket is never retried again.
3. Load company settings, agents, windows, active ticket counts, and latest assignment times. Aggregate by agent rather than querying each agent separately. Capture one decision time after acquiring the queue.
4. Evaluate and rank candidates. On success, update the ticket owner/time, insert the assignment and explanation, and delete the pending row. Use the same decision timestamp for `Ticket.assignedAt`, `Assignment.assignedAt`, and the response. If no agent qualifies, upsert only the pending row.
5. Commit before returning; release the queue after commit or rollback.

## 2. Availability, capacity, and selection

### Availability

Implement PRD §4.1 with the shared predicate below. Weekdays are Monday = 1 through Sunday = 7; times are integer minutes from midnight. Validation rejects equal start/end values before this function runs.

```ts
function isWindowActiveAt(w: WindowSpec, at: DateTime): boolean {
  const local = at.setZone(w.timezone);
  const minute = local.hour * 60 + local.minute;
  if (w.startMinute < w.endMinute) {
    return local.weekday === w.dayOfWeek
      && minute >= w.startMinute && minute < w.endMinute;
  }
  const nextDay = (w.dayOfWeek % 7) + 1;
  return (local.weekday === w.dayOfWeek && minute >= w.startMinute)
    || (local.weekday === nextDay && minute < w.endMinute);
}
```

An agent is available when any of their windows is active. Deduplicate agent IDs across windows and exclude removed agents. Evaluate recurring schedules in their authored timezone at the supplied instant.

### Capacity and fairness

Filter to non-removed agents of the requested company whose windows are active and whose `activeCount < maxActiveTicketsPerAgent`. Count `OPEN`, `IN_PROGRESS`, and `WAITING` tickets as active.

Implement PRD §4.4 with these sort keys, in order:

1. `activeCount`, lowest first.
2. `lastAssignedAt`, oldest first; null means never assigned and ranks first.
3. Agent ID, ascending using `localeCompare`.

Compute `lastAssignedAt` from `MAX(Assignment.assignedAt)`; do not store a second copy on the agent.

Aggregate active tickets and assignment history separately before joining them to agents. Joining both raw tables first would multiply rows and inflate workload counts. Agents without active tickets have a count of zero.

### Explanation

Persist the explanation with the assignment, including:

- `selected_agent`: ID and name.
- `eligibility`: an active window (`id`, `day`, `local` — the window's local time range as `HH:mm`–`HH:mm`, `timezone`), pre-assignment `active_tickets`, and `limit`.
- `decided_by`: the ranking key that separated the winner from the next-best candidate: `FEWEST_ACTIVE_TICKETS`, `NEVER_ASSIGNED`, `LEAST_RECENTLY_ASSIGNED`, or `AGENT_ID_TIEBREAK`. Use `ONLY_ELIGIBLE_AGENT` when there was no other candidate.

Do not persist a runner-up or a full per-agent candidate trace — the PRD (§4.6) only requires who was selected, why they were eligible, and which rule decided it. A pending result exposes a compact reason and count (below), not a rejection breakdown for every agent. Add a fuller audit payload later only if a real consumer needs it.

## 3. Concurrency and failure handling

### One queue per company

This is an in-process, synchronous mutex per company, not an asynchronous job queue: nothing is enqueued for later background processing. API calls and retries use the same `assignTicket` service and shared queue registry. The caller — the HTTP request handler itself, or the retry worker processing one ticket — waits in a FIFO line keyed by `companyId` for its turn, then runs the whole transaction synchronously within that same call, and only returns (the HTTP response, or control to the worker) after the transaction commits or rolls back and the lock is released. This serializes each company's decisions so every transaction sees the previous committed workload. Different companies use separate locks and never wait on each other. Locking only the ticket would not protect capacity shared across tickets.

Implement `withCompanyLock` with these guarantees:

1. A caller may wait up to **2 seconds** for its turn. Its transaction has not started during this wait.
2. If the wait expires, reject the caller and never invoke its work later.
3. A timed-out waiter must not release the current holder or let later callers pass that holder.
4. Once acquired, keep the queue held until the transaction actually commits or rolls back. The transaction has its own **5-second** execution timeout.

Never race the queue-wait timer against the running transaction.

### Atomic writes and failures

The writes in section 1 commit or roll back together. Pending outcomes do not change ticket ownership, workload, or assignment history.

On an assignment uniqueness conflict, let the losing transaction roll back, then read and replay the winning decision. This backstop prevents duplicate assignments for one ticket; capacity across different tickets still depends on the company queue.

Lock and transaction timeouts return `503 SERVICE_UNAVAILABLE` with `Retry-After: 5`. Database failures remain errors, never pending results. If a response is lost after commit, repeating the request returns the stored assignment.

A `503` does not write a pending row, so it is not picked up by the retry worker in section 4; unlike a pending outcome, it does not self-heal. The caller is expected to retry using `Retry-After`.

All assignment writers must use the queue in the same process. Multi-instance operation is outside this trial; see section 11.

## 4. Pending tickets and retries

Upsert one `PendingAssignment` row when evaluation finds no eligible agent. Use `NO_AVAILABLE_AGENT` when no valid agent is available; otherwise use `ALL_AVAILABLE_AGENTS_AT_CAPACITY`. Preserve `firstRequestedAt`, update the reason and `lastAttemptedAt`, and increment `attemptCount` on each completed pending evaluation. New rows start at one attempt.

Register the five-minute interval once from `instrumentation.ts`, including during development reloads. Each scheduled sweep reads up to 100 due rows, oldest `lastAttemptedAt` first, and calls `assignTicket` for each. Successful assignments and replays remove their pending rows through that service.

Catch each ticket’s error so the remaining batch still runs, and make sure a failing row cannot occupy the oldest position forever. A `TICKET_TERMINAL` error already removed the pending row inside `assignTicket` (section 1), so the worker only logs it. Any other error leaves the row pending — `assignTicket` did not complete an evaluation, so it never touched `lastAttemptedAt` or `attemptCount` itself — so the worker separately sets that row’s `lastAttemptedAt` to the sweep time and increments `attemptCount` before logging. This backs a repeatedly failing row off behind the next 5-minute window instead of leaving it as the oldest due row, so later-due, still-retryable tickets are never crowded out of the oldest-100 selection indefinitely.

A row is due when `lastAttemptedAt + 5 minutes <= sweep time`. Return that same threshold as `next_retry_at`. It is an eligibility time, not a promise of completion: the next interval and the batch limit can delay processing. Pending rows survive restarts.

There is no manual-trigger route or console for this; integration tests invoke the batch processor directly (bypassing the age filter) to exercise a retry without waiting five minutes.

## 5. Managing schedules and computing coverage

### Window storage and validation

Persist a multi-day create as one window row per selected weekday, in one transaction with a shared creation time. Edit or delete each day-row independently; `PATCH` replaces its times, timezone, and memberships.

Share the Zod schema between form and server, with server validation authoritative:

- Create requires at least one ISO weekday (1–7).
- Times must be `HH:mm` (00:00–23:59) and unequal; overnight ranges are valid.
- Check the IANA zone with `Info.isValidIANAZone`.
- Require at least one agent; every ID must belong to this company and be non-removed.

Soft removal keeps existing memberships so the UI can flag stale windows.

### Coverage calculation

Implement PRD §4.2 against a concrete reference week. Coverage uses schedules and removal status, independent of current ticket workload.

1. Resolve the requested date’s Monday-starting week in `company.supportTimezone`, defaulting to the current week. Use `startOf('week')` and add one calendar week, retaining Luxon’s default handling of clock transitions at the anchors.
2. Walk real one-minute instants from the start, inclusive, to the end, exclusive. Use elapsed-minute additions, not a list of local time labels and not a fixed 10,080-slot array.
3. At each instant, evaluate required hours in the company timezone and every availability window in its own timezone using `isWindowActiveAt`.
4. Collect sorted, deduplicated IDs of non-removed covering agents. A gap is a required minute with an empty set.
5. Group consecutive required minutes, covered minutes with the same agent set, and gap minutes into intervals. Agent handoffs produce separate covered intervals. Sum elapsed gap minutes for the total.

Return `timezone`, `week_start`, `week_end`, `required`, `covered`, `gaps`, and `total_gap_minutes`. Each interval has `day_of_week`, `start`, and `end`; covered intervals also have `agent_ids`, and gaps have `duration_minutes`.

Return interval boundaries as full ISO timestamps with offsets in the company timezone. They distinguish repeated local times; `day_of_week` is only for display. DST expectations are listed in section 9.

The cost is `O(elapsed minutes × windows × memberships per window)`. Reusing the availability predicate keeps assignment and coverage consistent.

## 6. Data model

Use the following Prisma models:

| Model | Fields |
| --- | --- |
| `Company` | `id`, `name`, `supportTimezone`, `maxActiveTicketsPerAgent`. |
| `Agent` | `id`, `companyId`, `name`, `email`, nullable `removedAt`. |
| `AvailabilityWindow` | `id`, `companyId`, `dayOfWeek`, `startMinute`, `endMinute`, `timezone`, `createdAt`, `updatedAt`. |
| `AvailabilityWindowAgent` | `windowId`, `agentId`; primary key `(windowId, agentId)`. |
| `RequiredSupportHours` | `id`, `companyId`, `dayOfWeek`, `startMinute`, `endMinute`; uses the company timezone and the same overnight rules. |
| `Ticket` | `id`, `companyId`, `status`, nullable `assigneeId` and `assignedAt`. |
| `Assignment` | `id`, `ticketId`, `agentId`, `assignedAt`, JSON `explanation`. |
| `PendingAssignment` | `ticketId`, `reasonCode`, `firstRequestedAt`, `lastAttemptedAt`, `attemptCount`; primary key `ticketId`. |

**Types/defaults:** string IDs with CUID defaults on standalone primary keys; integer weekdays, minutes (0–1439), limits, and counts; `DateTime` timestamps. Tickets default to `OPEN`, attempts to 1, and creation/assignment/pending timestamps to now. Maintain window `updatedAt` on edits.

**Relations:** company foreign keys on agents, windows, required hours, and tickets; window/agent foreign keys on memberships; optional assignee foreign key on tickets; ticket/agent foreign keys on assignments; ticket foreign key on pending rows. Window deletion cascades memberships.

`Assignment.ticketId` is unique for Prisma’s optional one-to-one ticket relation; `PendingAssignment` uses `ticketId` itself as its primary key, so no composite key is needed on either.

Memberships, assignments, and pending rows do not store their own `companyId`. Derive company ownership through the parent relation instead — membership → window → company, and assignment/pending → ticket → company — rather than a denormalized copy the app has to keep in sync on every write. Denormalize later only if a measured query needs it.

**Indexes.** Keep `Agent(companyId, removedAt)`, `AvailabilityWindow(companyId, dayOfWeek)`, `AvailabilityWindowAgent(agentId)`, `RequiredSupportHours(companyId)`, `Ticket(assigneeId, status)`, `Ticket(companyId, status)`, `Assignment(agentId, assignedAt)`, and `PendingAssignment(lastAttemptedAt)`.

`Ticket.assigneeId` supplies workload counts. `Assignment` stores the immutable automatic decision and fairness history. Seeded owners and decisions must agree.

## 7. API contracts

### Assignment

Request: `POST /api/assignments` with `{ "company_id": "cmp_1", "ticket_id": "tkt_42" }`.

**HTTP 200, assigned:**

```jsonc
{
  "status": "assigned",
  "ticket_id": "tkt_42",
  "assignee": { "id": "agt_7", "name": "Priya", "email": "priya@acme.com" },
  "assigned_at": "2026-09-20T09:14:03.118Z",
  "idempotent_replay": false,
  "explanation": { /* saved fields from section 2 */ }
}
```

**HTTP 200, pending:**

```jsonc
{
  "status": "pending",
  "ticket_id": "tkt_42",
  "reason": "ALL_AVAILABLE_AGENTS_AT_CAPACITY",
  "message": "3 agents are available, all at the 5-ticket limit.",
  "next_retry_at": "2026-09-20T09:19:03.118Z",
  "available_agent_count": 3
}
```

All errors use `{ "error": { "code": "...", "message": "...", "details": [] } }`. Validation details identify the fields to highlight.

| HTTP status / code | Condition |
| --- | --- |
| `422 VALIDATION_FAILED` | Malformed input, invalid schedule fields, or invalid coverage date. |
| `404 COMPANY_NOT_FOUND` | Company does not exist. |
| `404 TICKET_NOT_FOUND` | Ticket does not exist. |
| `422 TICKET_COMPANY_MISMATCH` | Ticket belongs to another company. |
| `409 TICKET_TERMINAL` | Ticket is terminal and has no saved assignment to replay. |
| `503 SERVICE_UNAVAILABLE` | Company queue or transaction timeout; include `Retry-After: 5`. |

### Other routes

| Method and path | Contract |
| --- | --- |
| `GET /api/companies/:companyId/availability-windows` | Windows and their agents; each membership includes `is_stale` for a removed agent. |
| `POST /api/companies/:companyId/availability-windows` | Accepts `days_of_week`, `start_time`, `end_time`, `timezone`, `agent_ids`; creates day-rows atomically. |
| `PATCH /api/availability-windows/:windowId` | Replaces `start_time`, `end_time`, `timezone`, and `agent_ids` on one day-row. |
| `DELETE /api/availability-windows/:windowId` | Deletes the window and its memberships. |
| `GET /api/companies/:companyId/coverage?week_start=YYYY-MM-DD` | Coverage intervals from section 5; optional date selects its containing week. |
| `GET /api/companies/:companyId/agents` | Agent details, `active_ticket_count`, `is_available_now`, and `removed_at`. |

## 8. Main UI flow

Select a seeded company → configure availability → review coverage gaps. The brief scopes the UI to configuring and reviewing team availability (PRD §7); the assignment API is exercised directly (curl example in section 10), not through a second, UI-only console.

| Page | Implementation |
| --- | --- |
| `/` | Pick a seeded company without entering an ID. |
| `/companies/:id/availability` | Weekday-grouped table and create/edit dialog with day/agent selectors, time inputs, and searchable timezone. Edit or delete one day-row at a time; deleting calls `DELETE /api/availability-windows/:windowId` and removes it from the table. Show overnight end-day labels, stale-agent warnings, and inline validation errors. |
| `/companies/:id/coverage` | Week selector, labeled company timezone, hourly grid backed by minute data, and gap list with durations. Show separate passes of repeated hours and mark skipped hours as nonexistent. |

Key requests by company and, for coverage, selected week. Discard responses for a selection the user has left so old data cannot appear under a new company or week.

Show loading, empty, and request-error states on each page. Keep form input when a save fails and disable repeat submission while it is running. Refresh the window list and coverage after a successful schedule change.

## 9. Edge cases

### Availability and validation

| Case | Expected behavior |
| --- | --- |
| Exactly at a window’s start | The window is active. |
| Exactly at a window’s end | The window is inactive; another active window may still make the agent available. |
| Start is later than end | Valid overnight window; continues into the next day. |
| Sunday 22:00–Monday 06:00 | Wraps into Monday. Coverage evaluates real instants at the reference week’s boundaries. |
| Start equals end | `422 VALIDATION_FAILED`; no window is saved. |
| Missing start or end time | `422 VALIDATION_FAILED` on the missing field; no window is saved. |
| Unknown IANA timezone | `422 VALIDATION_FAILED` on the timezone field. |
| Agent belongs to overlapping windows | Available if any window is active; counted once. |
| Agent is removed after window creation | Excluded from assignment and coverage; existing memberships remain and are flagged stale. |
| All agents in a window are removed | The window contributes no coverage. Required time becomes a gap unless another window covers it. |

### Assignment and pending tickets

| Case | Expected behavior |
| --- | --- |
| Ticket already has an assignment | Return the saved decision with `idempotent_replay: true`, even if now terminal. No workload or history change. |
| Ticket belongs to another company | `422 TICKET_COMPANY_MISMATCH`; no assignment is made. |
| Ticket is `RESOLVED` or `CLOSED`, with no saved assignment | `409 TICKET_TERMINAL`; delete any pending row for it so it is not retried again. |
| No agent is available | Pending with `NO_AVAILABLE_AGENT`; only the pending row is written. |
| Available agents all meet or exceed the limit | Pending with `ALL_AVAILABLE_AGENTS_AT_CAPACITY`. |
| Company limit is zero | Valid configuration; an unassigned, non-terminal ticket stays pending. Reason depends on whether any agent is available. |
| Company has no agents | Pending with `NO_AVAILABLE_AGENT`. |
| Repeated request still finds no eligible agent | Update the same pending row and increment `attemptCount`; preserve `firstRequestedAt`. No duplicate row. |

### Concurrency, timeouts, and retries

These cases assume the single-process queue in section 3.

| Case | Expected behavior |
| --- | --- |
| Concurrent calls for the same ticket | Serialize the calls. If the first assigns it, the next replays that decision; uniqueness prevents duplicate assignments. |
| Different tickets compete for one remaining slot | The next transaction reads updated workload, then selects another agent or returns pending. Capacity is not exceeded. |
| Caller exceeds the 2-second queue wait | `503 SERVICE_UNAVAILABLE` with `Retry-After: 5`. Its work never starts; the current holder keeps the queue. |
| Running transaction exceeds its 5-second budget | Roll back and return `503 SERVICE_UNAVAILABLE` with `Retry-After: 5`. Hold the queue until rollback finishes. |
| Retry finds a ticket already assigned | Replay the stored decision and delete any leftover pending row; do not assign again. |
| One retry throws (`TICKET_TERMINAL`) | Delete the pending row inside `assignTicket`, log, and continue with the remaining batch; the row is never selected again. |
| One retry throws (any other error) | Log the error, set that row’s `lastAttemptedAt` to the sweep time, and increment `attemptCount`; continue with the remaining batch. This backs the row off behind the next 5-minute window instead of leaving it as the oldest due row. |
| 100 pending rows keep failing every attempt (terminal, or erroring) | Terminal rows are deleted and never reselected; erroring rows back off behind the next window. A later-due, genuinely eligible ticket is retried within a bounded number of sweeps rather than being crowded out indefinitely. |

### Timezones and coverage

| Case | Expected behavior |
| --- | --- |
| Window timezone differs from company timezone | Evaluate availability in the window’s zone; display coverage in the company’s zone. |
| Window covers only a skipped spring-forward hour (e.g. a 02:00–02:30 window on the day clocks jump 02:00 → 03:00) | Inactive that day because those local times never occur; the window works normally on every other day. |
| Window covers a repeated fall-back hour (e.g. a 01:00–01:30 window on the day clocks go 02:00 → 01:00) | Active during both real passes of that local hour. |
| Required hour repeats, but another-zone window covers only one pass | Evaluate both passes separately and report the uncovered pass as a gap. Offset-bearing timestamps distinguish them. |
| Reference week includes spring-forward | Walk the shorter elapsed week; create no slots or gaps for nonexistent local times. |
| Coverage requested for a past or future week | Resolve that week’s boundaries and timezone offsets, then run the same calculation. |

## 10. Test plan and setup

Build in this order: schema and seed data → pure availability/ranking/coverage functions → transactional assignment service and queue → API and retry worker → UI.

| Test layer | Required coverage |
| --- | --- |
| Unit | Start/end boundaries; overnight and Sunday-to-Monday windows; overlapping memberships; removed agents; different timezones; DST skipped and repeated hours; all ranking rules and explanations; empty candidates; partial coverage and agent handoffs; past/future reference weeks. |
| Integration with real PostgreSQL | Assignment and explanation; replay without extra writes; both pending reasons and zero capacity; pending upserts; workload counts with multiple active tickets and history rows; all validation rules; company isolation; stale-agent exclusion; scheduled retry due-time boundaries, the batch processor invoked directly (bypassing the age filter), and success/replay/error isolation; terminal-retry row deletion and non-terminal-failure back-off; transactional rollback; same-ticket and shared-capacity concurrency; queue/transaction timeout responses. |
| Playwright | Create an overnight window → see it and its marker → confirm a coverage gap shrinks. |

Three regressions are essential:

- **Retry progress under poison rows:** seed 100 pending rows that fail every retry — a mix of now-terminal tickets (no saved assignment) and rows whose evaluation throws — plus one later pending ticket that is genuinely eligible. Run consecutive scheduled sweeps and assert the eligible ticket is assigned within a bounded number of sweeps: terminal rows must be deleted and never reselected, and erroring rows must back off behind the next window rather than permanently occupying the oldest-100 batch.
- **Slow transaction and waiting requests:** hold one transaction for about 2.4 seconds, within its 5-second execution budget. Verify no second same-company transaction enters before the first commits or rolls back. A caller that exceeds the 2-second wait receives 503 and must never start work or write its ticket afterward. A later caller must still wait behind the actual holder.
- **Coverage across DST:** in a mixed-timezone fall-back week, cover only one pass of a repeated required hour and assert the other pass remains a gap. In a spring-forward week, assert that the skipped hour creates no slot. Compare real instants and elapsed durations.

Run integration concurrency tests through independent database connections and clean up isolated fixtures afterward; an enclosing single-connection test transaction would hide the race being tested.

Seed two companies with different support timezones; agents/windows across `Asia/Kolkata`, `Europe/London`, and `America/New_York`; an overnight window; a removed agent still in a window; an agent at capacity; and a visible required-hours gap. Keep ticket owners and assignment records consistent.

```bash
docker compose up -d db       # PostgreSQL 16 on port 5432
npm install
npx prisma migrate dev
npm run seed
npm run dev                  # UI, API, and retry worker on port 3000

npm test                     # Vitest unit and integration tests
npm run test:e2e              # Playwright

# Exercise the assignment API directly, e.g. against a seeded ticket:
curl -X POST http://localhost:3000/api/assignments \
  -H "Content-Type: application/json" \
  -d '{"company_id": "cmp_1", "ticket_id": "tkt_42"}'
```

## 11. Trial boundaries and known limitations

Product exclusions remain in PRD §2 and assumptions in PRD §5. Implementation limits are:

- **Single process:** the company queue cannot protect capacity across application instances. Before scaling, use a database transaction-level lock per company with bounded acquisition and coordinate retry sweeps across instances.
- **Schedule edits:** concurrent edits are last-write-wins; changes across several day-rows are not atomic. Multi-day creation is atomic.
- **Scale and operations:** assignment-time caching, interval-based coverage, and metrics/tracing are deferred. The trial uses saved explanations, reason codes, and worker error logs, and runs locally without a deployment stage.