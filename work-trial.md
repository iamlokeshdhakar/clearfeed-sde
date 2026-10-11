# Work Trial: Support Ticket Assignment

## The problem

A support team's agents work different hours and days. Some cover mornings, some afternoons, some weekends and in different timezones. Today, a team lead watches the incoming ticket queue and assigns each new ticket to whoever they know is working. As a team grows, this breaks down:

- Tickets that arrive while the lead is offline sit unassigned for hours.
- The lead becomes a bottleneck, spending the day triaging instead of doing their own work.
- Work isn't shared evenly. Some agents get buried while others sit idle.

The product should assign each new ticket automatically: give it to someone on that company's team, respect who is available at that moment, and spread the work fairly across the team.

Customers have a few important expectations:

- A new ticket should not be left without an owner.
- A team lead should be able to see when the team's availability does not cover all times that need coverage.
- Agents should not keep receiving more work when they already have too much active work.
- A team lead should be able to understand why a ticket was assigned to a particular person.

## What you need to build

Build a service that allows managing a team's availability through a UI interface and an API which when called returns who should be assigned to a ticket.

1. **A UI to set up and manage a team's availability** Someone at a company defines when their agents are available, in which timezones and keeps it up to date.

2. **An assignment API** Expose an API: given a company_id and a ticket_id returns who on this company's team should be assigned to the ticket.

How you model availability and the assignment logic is your call. If you stub or simplify something, say so.

## Scope

You don't need login, billing, or account management. Skip mobile, holiday calendars, one-off overrides, and third-party integrations (PagerDuty, Opsgenie, and the like).

## How the trial works

The trial runs in three stages. Each stage is approved before you move to the next, and the trial can end at any stage. Work in a single public GitHub repo and open a PR for each stage.

1. **Product requirements (`prd.md`).** The problem as you understand it, the target user, scope, and assumptions.

2. **Technical design (`implementation.md`).** Your data model, the API, the main UI flow, edge cases, and a test plan.

3. **Implementation.** The code for the UI and the API, with tests for the most important behavior. Include setup and run instructions and a short note on what you'd build next.

## FAQ

**What tech stack can I use?**
Whatever you're most productive in. Any language, framework, and datastore is fine. Pick what lets you move fast and show your best work.

**Can I use AI tools like Cursor, Copilot, or Claude?**
Yes, and we encourage it. Use whatever you'd use in real work. You cover your own tool costs; we don't reimburse subscriptions for the trial.

**How exactly should "available" and "fairly" work?**
That's the core of the problem and your design to make. Decide how availability is defined, how you handle things like timezones, and how tickets get shared fairly, then explain your choices in the PRD and design doc.

**Who can manage availability? Do I need roles or permissions?**
Assume whoever uses the UI is allowed to. You don't need to build roles or permissions.

**Can I just build the API and skip the UI?**
No. Both are required. The UI doesn't need to be polished, but it needs to work.

**Do I need to create companies, agents, and tickets myself?**
No

**Does it need to be deployed or hosted?**
No. Running locally with clear setup instructions is enough.

**How much time should this take?**
We expect you to take 1.5 - 2 days for freezing implementation and prd docs. Rest of the time is for you to code.

**Where do I ask questions during the trial?**
Check this FAQ first. If something is still unclear, ping on the slack channel.