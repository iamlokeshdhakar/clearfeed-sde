# Product Requirements Document: Support Ticket Assignment

## 1. Problem and Goal

Support teams work across different hours, days, and timezones. When a team lead manually assigns incoming tickets, tickets can remain unassigned while the lead is offline, the lead becomes a routing bottleneck, and work can be distributed unevenly.

This feature should automate ticket assignment based on agent availability and active workload while helping team leads identify coverage gaps and understand assignment outcomes.

## 2. Goals and Non-Goals

### Goals

- Let team leads manage recurring agent availability across days and timezones.
- Automatically select an eligible assignee based on availability and workload.
- Distribute work fairly without assigning new tickets to overloaded agents.
- Show gaps in expected support coverage.
- Make assignment outcomes understandable.

### Non-Goals

The following are outside the scope of this trial:

- Authentication, authorization, account management, and billing.
- Mobile-specific experiences.
- Holiday calendars and one-off availability overrides.
- Third-party scheduling or on-call integrations.
- Creating or managing companies, agents, or tickets.
- Skills-based, priority-based, or SLA-based routing.
- Escalation policies, notifications, and historical analytics.
- Automatic retry scheduling or fallback queues.

## 3. Users and System Actor

### Team Lead / Support Manager

The primary user of the availability UI. They configure team schedules, review coverage gaps, and need to understand assignment outcomes.

### Support Agent

Receives tickets from the assignment system and should only receive new work while available and below the workload limit.

### Assignment API Consumer

An existing support workflow calls the assignment API with `company_id` and `ticket_id` when a ticket requires an owner.

## 4. Product Requirements

### 4.1 Manage Team Availability

A team lead should be able to create, edit, and remove recurring availability windows.

Each availability window defines:

- One or more days of the week.
- Start time.
- End time.
- Timezone.
- One or more agents.

An agent is available when the current time falls within at least one valid availability window associated with that agent.

Availability windows are **start-inclusive and end-exclusive**: the agent becomes available at the configured start time and is no longer available at the configured end time.

If a window crosses midnight, the selected weekday represents the day on which the window starts. For example, a Monday `22:00–06:00` window means the agent is available from Monday 22:00 until Tuesday 06:00.

Availability is evaluated using the timezone configured on the window.

Invalid availability windows should not be saved. The UI should show a clear validation error for cases such as:

- An unknown timezone.
- No valid agents.
- An agent that does not belong to the company.
- Missing start or end time.
- Start and end times being equal.

An end time earlier than the start time is valid and represents an overnight window.

If an existing window later contains a stale agent reference because that agent was removed from the company, the UI should visibly flag the affected window. The stale agent should not be considered for availability or assignment until the schedule is corrected.

### 4.2 Show Coverage Gaps

The team lead should be able to understand whether configured agent availability covers the times during which the company expects to provide support.

For this trial:

- Each company already has recurring required support hours.
- Each company has a support timezone.
- Required support hours and the coverage view are shown in the company support timezone.
- Agent availability configured in other timezones is converted to the company support timezone when calculating coverage.

The UI should clearly highlight periods inside required support hours where no valid agent availability exists.

### 4.3 Determine Eligibility and Avoid Overload

When an assignment is requested, an agent is eligible only when:

- The agent belongs to the requested company.
- The agent is currently available.
- The agent's active workload is below the team's configured active-ticket limit.

An active ticket is any ticket considered non-terminal by the existing or stubbed ticket data.

The team has a shared maximum active-ticket limit per agent. Agents at that limit are considered overloaded and are excluded from new assignments.

### 4.4 Fair Assignment

When multiple agents are eligible, fairness is defined as:

1. Prefer the eligible agent with the fewest active tickets.
2. If multiple agents have the same active ticket count, prefer the agent who was assigned a ticket least recently.
3. An agent who has never received a ticket ranks ahead of agents who have previously received one.
4. If agents are still tied, use the agent's unique ID in ascending order as the final deterministic tie-breaker.

The ID-based tie-breaker does not represent a fairness preference; it exists only to make identical assignment inputs deterministic and testable.

### 4.5 Assignment API

The assignment API accepts:

- `company_id`
- `ticket_id`

It evaluates agents using the availability, workload, and fairness rules above and returns either:

- The selected assignee, or
- A pending-assignment result with a clear reason when no agent is eligible.

The first successful assignment for a given `company_id` and `ticket_id` establishes that ticket's assignment decision for the trial.

Repeated requests for the same successfully assigned ticket return the same assignee and do not affect workload or assignment history more than once.

Unsuccessful attempts do not establish an assignment and may be retried after availability or workload conditions change.

The assignment service is assumed to have access to current workload and previous assignment information required to evaluate these rules.

The exact API schema, persistence mechanism, and internal data model will be defined in `implementation.md`.

### 4.6 Explain Assignment Outcomes

A successful assignment should include enough information to explain:

- Which agent was selected.
- Why that agent was eligible.
- Which fairness rule caused that agent to be selected.

When an assignment cannot be made, the result should expose the main reason, such as:

- No agents are currently available.
- All currently available agents are at the active-ticket limit.

### 4.7 No Eligible Assignee

If no valid assignee exists, the system should not assign the ticket to an unavailable or overloaded agent only to force ownership.

The ticket enters an explicit pending assignment state, and the assignment result includes a clear reason such as no_available_agent or all_available_agents_at_capacity.

Pending assignments are automatically retried every 5 minutes using the same availability, workload, and fairness rules.

If an eligible agent becomes available, the retry establishes the ticket's assignment using the same stable/idempotent behavior defined in Section 4.5. If no agent is eligible, the ticket remains pending and is evaluated again on the next retry.

Automatic retry is intentionally simple for the trial. A fixed retry interval avoids tickets remaining indefinitely unassigned without introducing a more complex scheduling, fallback-owner, or escalation system.

Fallback owners, queues, and escalation policies remain outside the scope of this trial.

## 5. Trial Assumptions and Simplifications

For this trial:

- Companies, agents, and tickets already exist and may be represented using seeded or stubbed data.
- Ticket status, current workload, and previous assignment information are available to the assignment service.
- The existing or stubbed ticket data determines whether a ticket is terminal or contributes to active workload.
- Each company already has recurring required support hours and a support timezone.
- Each company has a shared maximum active-ticket limit per agent.
- Availability is represented using recurring weekly schedules and named timezones.
- The assignment service does not create companies, agents, or tickets.
- Automatic retries and fallback assignment policies are intentionally not implemented.

## 6. Acceptance Criteria

### Availability

- A team lead can create, edit, and remove recurring availability windows.
- Start-inclusive/end-exclusive boundary behavior is consistent.
- Overnight windows behave according to the weekday on which they start.
- Invalid windows are rejected with a visible error.
- Stale agent references are visibly flagged and excluded from assignment.

### Coverage

- The UI shows recurring team availability in the company support timezone.
- Coverage gaps inside required support hours are clearly visible.

### Assignment

- Only agents belonging to the company, currently available, and below the active-ticket limit are eligible.
- Assignment follows the fairness and deterministic tie-break rules in Section 4.4.
- A successful assignment remains stable across repeated calls for the same `company_id` and `ticket_id`.
- Repeated calls do not increase workload or assignment history more than once.

### Pending Assignment

- When no eligible agent exists, the API returns a pending-assignment result with a clear reason.
- An unsuccessful attempt does not affect workload or assignment history.
- The request can be retried after availability or workload changes.
- Pending assignments are automatically re-evaluated every 5 minutes.
- Once a retry successfully assigns the ticket, it leaves the pending state and is not assigned again by later retries.

### Explainability

- A successful assignment identifies who was selected and why.
- An unsuccessful assignment clearly identifies why an assignee could not be selected.

## 7. Scope Summary

This trial focuses on two product capabilities:

1. A working UI for configuring and reviewing team availability.
2. An assignment API that returns an assignment outcome based on availability, workload, and fairness.

Technical details such as the data model, exact endpoint schemas, persistence implementation, concurrency handling, UI component structure, detailed edge cases, and test plan belong in `implementation.md`.
