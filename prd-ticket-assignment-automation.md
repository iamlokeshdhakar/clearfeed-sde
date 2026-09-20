# Product Requirements Document: Support Ticket Assignment

## 1. Overview

Support teams often work across different hours, days, and timezones. Today, a team lead may need to monitor the incoming ticket queue and manually decide who should handle each new ticket.

This becomes difficult as the team grows. Tickets can remain unassigned when the lead is offline, the lead becomes a routing bottleneck, and workload can become uneven across agents.

The goal of this feature is to automate ticket assignment based on team availability and current workload, while giving team leads visibility into coverage gaps and enough context to understand assignment decisions.

## 2. Problem Statement

A growing support team needs a reliable way to assign incoming tickets without depending on a team lead to continuously monitor and triage the queue.

The product needs to account for:

- Agents working different days, hours, and timezones.
- Tickets arriving when the team lead is unavailable.
- Uneven workload across available agents.
- Agents who already have too much active work.
- Gaps in the team's support coverage.
- The need to understand why a particular assignment was made.

## 3. Goals and Non-Goals

### Goals

The product should:

- Allow a team lead to configure and maintain recurring availability for support agents.
- Support schedules across different days, working hours, and timezones.
- Determine who is eligible to receive a ticket at the time an assignment is requested.
- Avoid assigning new work to agents who are already overloaded.
- Distribute work fairly among eligible agents.
- Make coverage gaps visible to the team lead.
- Make assignment decisions understandable.
- Provide an assignment API that accepts a `company_id` and `ticket_id` and returns who should be assigned.

### Non-Goals

The following are outside the scope of this trial:

- Authentication, authorization, and account management.
- Billing.
- Mobile-specific experiences.
- Holiday calendars.
- One-off availability overrides.
- Third-party scheduling or on-call integrations.
- Creating or managing companies, agents, or tickets.
- Skills-based routing.
- Priority- or SLA-based routing.
- Escalation workflows.
- Notifications and historical analytics.

## 4. Target Users and System Actor

### Team Lead / Support Manager

The primary user of the availability management UI.

They need to:

- Define when support agents are available.
- Keep schedules up to date.
- Understand whether the team has gaps in support coverage.
- Avoid repeatedly overloading the same agents.
- Understand why an assignment was made.

### Support Agent

A support agent receives tickets selected by the assignment system.

They should:

- Receive new tickets only while they are available.
- Stop receiving new work once they are considered overloaded.
- Receive a fair share of work compared with other eligible agents.

A dedicated agent-facing configuration experience is not required for this trial.

### Assignment API Consumer

An existing support or ticketing workflow calls the assignment API when a ticket needs an owner.

The caller provides:

- `company_id`
- `ticket_id`

The API returns the assignment decision. The existing ticketing system is assumed to remain responsible for the underlying ticket data.

## 5. Product Requirements

### 5.1 Manage Team Availability

A team lead should be able to create and maintain recurring availability schedules.

For each availability window, the lead should be able to define:

- One or more days of the week.
- Start time.
- End time.
- Timezone.
- One or more agents.

The lead should also be able to edit or remove an existing availability window.

Invalid availability windows should not be saved. The UI should show a clear validation error for configurations such as an unknown timezone, no valid agents, or an agent that does not belong to the company. A start and end time must be provided; equal start and end times are invalid, while end times earlier than the start time represent an overnight window.

If an existing availability window later contains a stale agent reference because that agent was removed from the company, the UI should visibly flag the affected window. The stale agent should not be considered for availability or assignment until the schedule is corrected.

An agent is considered available when the current time falls within at least one configured availability window associated with that agent. Availability windows are start-inclusive and end-exclusive: the agent becomes available at the configured start time and is no longer available at the configured end time.

If an availability window crosses midnight, the selected weekday represents the day on which the window starts. For example, a Monday 22:00–06:00 window represents availability from Monday 22:00 until Tuesday 06:00.

Availability should be evaluated in the configured timezone.

### 5.2 Show Coverage Gaps

The team lead should be able to understand whether the configured availability covers the times during which the team is expected to provide support.

The UI should:

- Show the team's recurring availability across the week.
- Highlight periods where required support coverage exists but no agents are scheduled.

For this trial:

- Each company is assumed to already have recurring required support hours.
- Each company has a support timezone.
- Required support hours and the coverage view are shown in the company's support timezone.
- Agent availability configured in other timezones is converted to the company support timezone when calculating coverage gaps.

### 5.3 Determine Agent Eligibility

When an assignment is requested, the system should first determine the set of eligible agents.

An agent is eligible when:

- They belong to the requested company.
- They are available at the time of the request.
- Their active workload is below the team's active-ticket limit.

Agents who do not meet all of these conditions should not participate in the assignment decision.

### 5.4 Avoid Overloading Agents

The system should use active ticket workload to prevent agents from continuously receiving new work when they already have too much active work.

For this trial, an active ticket is any ticket considered non-terminal by the existing ticket system.

The team has a shared maximum active-ticket limit per agent. An agent who has reached that limit is considered overloaded and is excluded from new assignments.

The exact numeric limit can be provided through seeded/configured company data for the trial.

### 5.5 Fair Assignment

When multiple agents are eligible, the system should distribute work based on current workload.

For this trial, fairness is defined as:

1. Prefer the eligible agent with the fewest active tickets.
2. If multiple agents have the same active ticket count, prefer the agent who was assigned a ticket least recently.
3. An agent who has never received a ticket is considered less recently assigned than any agent who has previously received one.
4. If multiple agents are still tied, use the agent's unique ID in ascending order as the final deterministic tie-breaker.

The final ID-based tie-breaker does not represent a fairness preference; it only ensures that identical assignment inputs always produce the same result.

This keeps the rule easy to understand and ensures that work is spread across the currently eligible team instead of relying only on a fixed rotation.

### 5.6 Assignment API

The product should expose an API that accepts:

- `company_id`
- `ticket_id`

The assignment service should:

1. Identify agents belonging to the company.
2. Determine who is currently available.
3. Exclude agents who are already at the team's active-ticket limit.
4. Apply the fairness rule.
5. Return the selected assignee.

The first successful assignment request for a given company_id and ticket_id establishes that ticket’s assignment decision for the trial.

Repeated requests for the same company_id and ticket_id should return the same assignee and should not count the ticket toward workload or assignment history more than once.

The assignment service therefore behaves idempotently for repeated requests. The exact persistence mechanism used to preserve this behavior will be defined in implementation.md.

The exact API schema, persistence mechanism, and internal data model used to support this behavior will be defined in implementation.md.

### 5.7 Explain Assignment Decisions

A team lead should be able to understand why a ticket was assigned to a particular agent.

The assignment result should contain enough information to explain:

- Why the selected agent was eligible.
- Which fairness rule caused that agent to be selected.

When an assignment cannot be made, the result should expose the main reason, such as no agents being available or all available agents being at the workload limit.

### 5.8 No Eligible Assignee

There may be times when no valid assignee exists, for example:

- No agents are currently available.
- Agents are available, but all have reached the team's active-ticket limit.

In these cases, the system will not assign the ticket to an unavailable or overloaded agent only to force ownership.

For this trial, this is handled as an explicit pending assignment state. The assignment API returns no assignee together with a clear reason explaining why assignment could not be completed.

A ticket in the pending assignment state may be retried by calling the assignment API again after availability or workload conditions change. Unsuccessful attempts do not establish an assignment or affect workload/history. Once a retry successfully selects an agent, that assignment becomes the ticket's assignment decision.

Automatically scheduling retries, fallback owners, queues, and escalation policies are outside the scope of this trial.


## 6. Trial Assumptions and Simplifications

For this trial:

- Companies, agents, and tickets already exist and may be represented using seeded or stubbed data.
- Ticket status, current workload, and previous assignment information are assumed to be available to the assignment service.
- Each company already has required support hours, a support timezone, and a configured active-ticket limit per agent.
- The existing or stubbed ticket data determines whether a ticket is terminal or still contributes to active workload.
- Automatic retry scheduling, fallback queues, and escalation policies are outside the scope of the trial.

## 7. Acceptance Criteria

### Availability Management

- A team lead can create, edit, and remove recurring availability windows.
- Invalid availability configurations are rejected with a visible error.
- Stale agent references are visibly flagged and are not used for assignment.
- Availability behavior at schedule boundaries and across midnight follows the rules defined in Section 5.1.

### Coverage

- The UI shows recurring team availability in the company's support timezone.
- Coverage gaps inside the company's required support hours are clearly visible.

### Assignment

- A valid assignment request returns an eligible assignee according to the rules defined in Section 5.
- A successful assignment is stable for repeated requests for the same company and ticket and does not affect workload/history more than once.
- When no eligible agent exists, the result enters the defined pending-assignment behavior and clearly explains why assignment could not be completed.
- A pending assignment can be retried after availability or workload conditions change.

### Explainability

- A successful assignment identifies the selected agent and why they were selected.
- An unsuccessful assignment clearly identifies the reason it could not be completed.

## 8. Scope Summary

This trial focuses on two product capabilities:

1. A working UI for configuring and reviewing team availability.
2. An assignment API that returns the appropriate assignee based on availability, workload, and fairness.

Technical details such as the data model, endpoint schemas, persistence strategy, concurrency handling, detailed API edge cases, UI component structure, and test plan belong in `implementation.md`.
