"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  PlayIcon,
  RefreshCwIcon,
} from "lucide-react";
import { use, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError, apiRequest } from "@/lib/api-client";
import type {
  AssignmentResultDTO,
  PendingAssignmentDTO,
  TicketSummaryDTO,
} from "@/lib/api-types";

const DAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const DECIDED_BY_LABELS: Record<string, string> = {
  FEWEST_ACTIVE_TICKETS: "Fewest active tickets",
  NEVER_ASSIGNED: "Never assigned before",
  LEAST_RECENTLY_ASSIGNED: "Least recently assigned",
  AGENT_ID_TIEBREAK: "Deterministic ID tiebreak",
  ONLY_ELIGIBLE_AGENT: "Only eligible agent",
};

const REASON_LABELS: Record<string, string> = {
  NO_AVAILABLE_AGENT: "No agents currently available",
  ALL_AVAILABLE_AGENTS_AT_CAPACITY: "All available agents at capacity",
};

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AssignmentsReviewPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);
  const [tickets, setTickets] = useState<TicketSummaryDTO[] | null>(null);
  const [pending, setPending] = useState<PendingAssignmentDTO[] | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string>("");
  const [result, setResult] = useState<AssignmentResultDTO | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const [ticketsRes, pendingRes] = await Promise.all([
          apiRequest<{ tickets: TicketSummaryDTO[] }>(
            `/api/companies/${companyId}/tickets`,
            { signal },
          ),
          apiRequest<{ pending: PendingAssignmentDTO[] }>(
            `/api/companies/${companyId}/pending-assignments`,
            { signal },
          ),
        ]);
        if (signal?.aborted) return;
        setTickets(ticketsRes.tickets);
        setPending(pendingRes.pending);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof ApiClientError ? err.message : "Failed to load data.",
        );
      }
    },
    [companyId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setTickets(null);
    setPending(null);
    setResult(null);
    setSelectedTicketId("");
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleAssign() {
    if (!selectedTicketId) return;
    setAssigning(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiRequest<AssignmentResultDTO>(
        "/api/assignments",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_id: companyId,
            ticket_id: selectedTicketId,
          }),
        },
      );
      setResult(response);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to request an assignment.",
      );
    } finally {
      setAssigning(false);
    }
  }

  const loading = tickets === null || pending === null;

  return (
    <section className="flex flex-col gap-6">
      {/* Header Description */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold tracking-tight">
            Assignments Reviewer
          </h2>
          <Badge
            variant="outline"
            className="text-[10px] uppercase font-semibold text-muted-foreground"
          >
            Review Simulator
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Simulate real-time ticket assignment decisions by exercising{" "}
          <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">
            POST /api/assignments
          </code>{" "}
          and inspecting candidate eligibility and fairness rationale.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-destructive/10 border border-destructive/20 p-3.5 text-sm text-destructive font-medium">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Simulator Control Card */}
      {loading ? (
        <Skeleton className="h-28 w-full rounded-2xl" />
      ) : (
        <Card className="border-border/80 shadow-xs">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-1 flex-col gap-2">
              <label
                htmlFor="ticket-select"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Select Ticket to Assign
              </label>
              {tickets.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No tickets seeded for this company workspace.
                </p>
              ) : (
                <Select
                  value={selectedTicketId}
                  onValueChange={(value) => setSelectedTicketId(value ?? "")}
                >
                  <SelectTrigger
                    id="ticket-select"
                    className="w-full font-mono text-xs h-10"
                  >
                    <SelectValue placeholder="Choose a ticket from company queue..." />
                  </SelectTrigger>
                  <SelectContent>
                    {tickets.map((ticket) => (
                      <SelectItem
                        key={ticket.id}
                        value={ticket.id}
                        className="text-xs font-mono"
                      >
                        <span className="font-semibold">
                          {shortId(ticket.id)}
                        </span>
                        <span className="mx-1.5 text-muted-foreground">•</span>
                        <span className="uppercase text-[10px] font-bold tracking-wider">
                          {ticket.status}
                        </span>
                        {ticket.assignee && (
                          <span className="text-muted-foreground ml-2">
                            (Assigned: {ticket.assignee.name})
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Button
              onClick={handleAssign}
              disabled={!selectedTicketId || assigning}
              className="h-10 gap-2 font-semibold shadow-xs shrink-0"
            >
              {assigning ? (
                <>
                  <RefreshCwIcon className="size-4 animate-spin" />
                  <span>Evaluating Routing Rules...</span>
                </>
              ) : (
                <>
                  <PlayIcon className="size-4" />
                  <span>Assign Ticket</span>
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Result Outcome Display */}
      {result && (
        <Card
          className={`border-2 transition-all ${
            result.status === "assigned"
              ? "border-emerald-500/40 bg-emerald-50/20 dark:bg-emerald-950/10"
              : "border-rose-500/40 bg-rose-50/20 dark:bg-rose-950/10"
          }`}
        >
          <CardContent className="flex flex-col gap-4 p-5">
            {result.status === "assigned" ? (
              <>
                {/* Header Status */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-emerald-600 text-white gap-1 px-2.5 py-0.5 text-xs font-semibold">
                      <CheckCircle2Icon className="size-3.5" />
                      Ticket Assigned Successfully
                    </Badge>

                    {result.idempotent_replay && (
                      <Badge
                        variant="secondary"
                        className="gap-1 text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                      >
                        <RefreshCwIcon className="size-3" />
                        Idempotent Replay (Saved Decision)
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground font-mono">
                    Assigned at: {formatDateTime(result.assigned_at)}
                  </span>
                </div>

                {/* Assignee Card */}
                <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 shadow-xs">
                  <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold text-lg brand-gradient-bg">
                    {result.assignee.name.charAt(0)}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-base font-bold">
                      {result.assignee.name}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {result.assignee.email}
                    </span>
                  </div>
                </div>

                {/* Explanation Breakdown Grid */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 pt-1">
                  <div className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-xs">
                    <span className="font-medium text-muted-foreground">
                      Fairness Decision Rule
                    </span>
                    <Badge
                      variant="outline"
                      className="w-fit text-xs font-semibold border-primary/40 text-primary mt-1"
                    >
                      {DECIDED_BY_LABELS[result.explanation.decided_by] ??
                        result.explanation.decided_by}
                    </Badge>
                  </div>

                  <div className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-xs">
                    <span className="font-medium text-muted-foreground">
                      Eligible Work Shift
                    </span>
                    <span className="font-semibold text-foreground mt-0.5 font-mono">
                      {DAY_NAMES[result.explanation.eligibility.window.day]}{" "}
                      {result.explanation.eligibility.window.local} (
                      {result.explanation.eligibility.window.timezone})
                    </span>
                  </div>

                  <div className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-xs">
                    <span className="font-medium text-muted-foreground">
                      Active Workload at Selection
                    </span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="font-bold text-foreground font-mono">
                        {result.explanation.eligibility.active_tickets} /{" "}
                        {result.explanation.eligibility.limit} active tickets
                      </span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Pending Status Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="destructive"
                      className="gap-1 px-2.5 py-0.5 text-xs font-semibold"
                    >
                      <AlertCircleIcon className="size-3.5" />
                      Pending Assignment State
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground font-mono">
                    Next Auto-Retry: {formatDateTime(result.next_retry_at)}
                  </span>
                </div>

                <div className="flex flex-col gap-2 rounded-xl bg-card border p-4">
                  <p className="text-sm font-semibold text-foreground">
                    {result.message}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-1">
                    <span>
                      Reason Code:{" "}
                      <Badge
                        variant="outline"
                        className="font-mono text-destructive border-destructive/30"
                      >
                        {REASON_LABELS[result.reason] ?? result.reason}
                      </Badge>
                    </span>
                    <span>•</span>
                    <span>
                      Available Agents Now:{" "}
                      <span className="font-bold text-foreground font-mono">
                        {result.available_agent_count}
                      </span>
                    </span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pending Tickets Retry Queue Section */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold tracking-tight">
            Pending Retry Queue ({pending?.length ?? 0} tickets awaiting retry)
          </h3>
          <span className="text-xs text-muted-foreground">
            5-minute automatic retry sweep active
          </span>
        </div>

        {loading ? (
          <Skeleton className="h-20 w-full rounded-xl" />
        ) : pending.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-xs text-muted-foreground">
              No tickets are currently pending retry. All requested tickets have
              been assigned to available agents.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {pending.map((row) => (
              <Card key={row.ticket_id} className="border-border/80">
                <CardContent className="flex flex-col gap-2 p-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="font-bold font-mono text-sm text-foreground"
                        title={row.ticket_id}
                      >
                        {shortId(row.ticket_id)}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono"
                      >
                        Attempt #{row.attempt_count}
                      </Badge>
                    </div>
                    <Badge variant="destructive" className="font-mono text-xs">
                      {REASON_LABELS[row.reason] ?? row.reason}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 pt-2 text-muted-foreground border-t border-border/40 font-mono text-[11px]">
                    <div>
                      <span className="block text-[10px] uppercase text-muted-foreground/70">
                        First Requested
                      </span>
                      <span>{formatDateTime(row.first_requested_at)}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase text-muted-foreground/70">
                        Last Attempted
                      </span>
                      <span>{formatDateTime(row.last_attempted_at)}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase font-semibold text-primary">
                        Next Retry At
                      </span>
                      <span className="font-semibold text-foreground">
                        {formatDateTime(row.next_retry_at)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
