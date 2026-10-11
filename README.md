# clearfeed — Support Ticket Assignment

Automates support ticket assignment based on agent availability and
workload, with a UI for managing team schedules and coverage gaps. See
[`prd-ticket-assignment-automation.md`](prd-ticket-assignment-automation.md)
and [`implementation.md`](implementation.md) for the product and technical
design.

Stack: Next.js, PostgreSQL + Prisma, Zod, Luxon, Vitest, Playwright.

## Setup

Requires Docker, Node 20+, and pnpm.

```bash
docker compose up -d db   # PostgreSQL 16 on port 5432 (app + test databases)
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm seed                 # seeds companies from prisma/seed-data.json
pnpm dev                  # http://localhost:3000
```

Open the app and pick a seeded company. The UI covers availability and
coverage (the PRD's actual scope); the assignment API is meant to be called
directly by a caller like curl:

```bash
curl -X POST http://localhost:3000/api/assignments \
  -H "Content-Type: application/json" \
  -d '{"company_id": "<id>", "ticket_id": "<id>"}'
```

Find `company_id`/`ticket_id` from the **Assignments (review only)** tab or create custom test tickets in the **Ticket Sandbox (create & test)** tab on any company page — these review tabs let reviewers test the assignment engine and create test tickets directly from the UI without curl.

## Review-Only Pages (For Evaluation & Testing)

To assist reviewers in evaluating the assignment automation system, two dedicated UI pages are available under each company workspace (`/companies/:id`):

1. **Assignments Reviewer (`/companies/:id/assignments`)**:
   - Select seeded tickets from the company queue.
   - Trigger `POST /api/assignments` with a single click.
   - View assignee details, active workload counters, fairness rule explanations (`FEWEST_ACTIVE_TICKETS`, `NEVER_ASSIGNED`, `LEAST_RECENTLY_ASSIGNED`, etc.), or 5-minute retry queue schedules.

2. **Ticket Sandbox & Generator (`/companies/:id/tickets`)**:
   - Create custom test tickets on-the-fly via the UI with custom IDs (or auto-generated IDs like `tkt_test_x8z2a`).
   - Choose initial ticket status (`OPEN`, `IN_PROGRESS`, `WAITING`, `RESOLVED`, `CLOSED`).
   - Toggle **Run Assignment Engine Immediately** to execute instant routing simulations upon creation.
   - View the company ticket roster, run manual assignments, and delete test tickets.

## Retries

If a ticket can't be assigned (no agent available, or everyone's full), it's
saved as "pending" instead of failing. Every 5 minutes, a background job
automatically retries all pending tickets to see if an agent has since
become available. This runs on its own inside `pnpm dev` / `pnpm start` —
no separate process or command needed.

Code: [`src/lib/retry/batchProcessor.ts`](src/lib/retry/batchProcessor.ts)
(the retry logic) and [`src/instrumentation.ts`](src/instrumentation.ts)
(schedules it every 5 minutes).

## Manual testing

Companies, agents, and tickets are intentionally not creatable through the API
or UI (see PRD §2 non-goals) — the two seeded companies are the supported way
to exercise the product by hand.

**Trigger an assignment for a ticket:**

1. Run `pnpm seed` to get two companies: Acme Support (unassigned `OPEN`/
   `RESOLVED` tickets, plus 3 already-assigned) and Globex Support (an
   unassigned `OPEN` and `WAITING` ticket).
2. Open `/companies/:id/assignments` ("Assignments (review only)" tab), pick
   a ticket from the dropdown, and click **Assign** — it calls
   `POST /api/assignments` and shows the resulting assignee/explanation or
   pending reason.
3. Or call the API directly with a `ticket_id` from that dropdown (or from
   `GET /api/companies/:companyId/tickets`):
   ```bash
   curl -X POST http://localhost:3000/api/assignments \
     -H "Content-Type: application/json" \
     -d '{"company_id": "<id>", "ticket_id": "<id>"}'
   ```
4. To create custom tickets on-the-fly, use the **Ticket Sandbox (`/companies/:id/tickets`)** tab in the UI. Alternatively, you can add a `tickets` entry to [`prisma/seed-data.json`](prisma/seed-data.json) and re-run `pnpm seed`, insert one directly with `npx prisma studio` (`localhost:5555`), or use the `createTicket()` fixture helper in [`src/lib/testing/fixtures.ts`](src/lib/testing/fixtures.ts).

**Test a company with different support hours/timezone:**

- The seed already gives you two: Acme (`America/New_York`, weekdays
  09:00–18:00, plus a Saturday 10:00–14:00 window left deliberately
  uncovered to show a coverage gap) and Globex (`Asia/Kolkata`, weekdays
  09:00–18:00). Re-running `pnpm seed` resets and recreates both.
- For a custom scenario (e.g. DST edge cases), there's still no create-company
  endpoint, but you don't need to touch `seed.ts` — add another entry to the
  `companies` array in [`prisma/seed-data.json`](prisma/seed-data.json) and
  re-run `pnpm seed`. Each entry declares `requiredSupportHours`, `agents`
  (with a local `key` used to reference them), `windows` (by `agentKeys`),
  and `tickets` (optionally `assigneeKey` + `assignedHoursAgo` to also seed
  an assignment history row); [`prisma/seed.ts`](prisma/seed.ts) just walks
  the JSON and creates the rows, so no code changes are needed to add more
  companies, agents, windows, or tickets.
- If you need something the JSON shape can't express, insert rows directly
  via Prisma Studio, or use the `createCompany()`/`createWindow()` fixture
  helpers from [`src/lib/testing/fixtures.ts`](src/lib/testing/fixtures.ts)
  in a scratch script — the same helpers the integration tests use.

**`prisma/seed-data.json` shape** (one object per company in `companies`):

| Field                                                 | Notes                                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`, `supportTimezone`, `maxActiveTicketsPerAgent` | Maps 1:1 to the `Company` model.                                                                                                                                                                             |
| `requiredSupportHours[]`                              | `{ daysOfWeek: number[], startTime, endTime }` in `HH:mm`, one entry expands into one row per day.                                                                                                           |
| `agents[]`                                            | `{ key, name, email, removed? }`. `key` is a local, seed-only alias used to reference the agent elsewhere in the file — it isn't stored.                                                                     |
| `windows[]`                                           | `{ daysOfWeek: number[], startTime, endTime, timezone, agentKeys: string[] }`; expands into one `AvailabilityWindow` row per day, same as the create API.                                                    |
| `tickets[]`                                           | `{ status, assigneeKey?, assignedHoursAgo? }`. Omit both optional fields for an unassigned ticket; set both to also create a matching `Assignment` history row (`assignedHoursAgo` back-dates `assignedAt`). |

`prisma/seed.ts` only reads this file and creates rows — extending the seed
data never requires touching that script.

## Tests

```bash
pnpm test              # unit tests (no database needed)
pnpm test:integration  # integration tests (needs `docker compose up -d db`)
pnpm test:e2e          # Playwright e2e (starts the dev server if needed)
```

```bash
pnpm lint     # Biome
pnpm format   # Biome, writes fixes
pnpm build    # production build
```
