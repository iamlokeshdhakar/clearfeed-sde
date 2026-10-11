"use client";

import {
  CheckCircle2Icon,
  ClockIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  TicketIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserCheckIcon,
} from "lucide-react";
import { use, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError, apiRequest } from "@/lib/api-client";
import type { TicketSummaryDTO } from "@/lib/services/ticketService";

const DECIDED_BY_LABELS: Record<string, string> = {
  FEWEST_ACTIVE_TICKETS: "Fewest Active Tickets",
  NEVER_ASSIGNED: "Never Assigned Before",
  LEAST_RECENTLY_ASSIGNED: "Least Recently Assigned",
  AGENT_ID_TIEBREAK: "Agent ID Tiebreaker",
  ONLY_ELIGIBLE_AGENT: "Only Eligible Agent",
};

interface AssignmentExplanationDTO {
  selected_agent: { id: string; name: string };
  eligibility: {
    window: { id: string; day: number; local: string; timezone: string };
    active_tickets: number;
    limit: number;
  };
  decided_by: string;
}

interface AssignmentOutcomeResponse {
  status: "assigned" | "pending";
  ticket_id: string;
  assignee?: { id: string; name: string; email: string };
  assigned_at?: string;
  explanation?: AssignmentExplanationDTO | string;
  reason?: string;
  message?: string;
  next_retry_at?: string;
  idempotent_replay?: boolean;
}

export default function ReviewerTicketsPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);
  const [tickets, setTickets] = useState<TicketSummaryDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [customId, setCustomId] = useState("");
  const [status, setStatus] = useState<
    "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED"
  >("OPEN");
  const [assignImmediately, setAssignImmediately] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [actionTicketId, setActionTicketId] = useState<string | null>(null);

  // Last outcome state
  const [lastOutcome, setLastOutcome] =
    useState<AssignmentOutcomeResponse | null>(null);

  const loadTickets = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await apiRequest<{ tickets: TicketSummaryDTO[] }>(
          `/api/companies/${companyId}/tickets`,
          { signal },
        );
        if (signal?.aborted) return;
        setTickets(res.tickets);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : "Failed to load tickets list.",
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [companyId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadTickets(controller.signal);
    return () => controller.abort();
  }, [loadTickets]);

  const handleAutoGenerateId = () => {
    const randomSuffix = Math.random().toString(36).substring(2, 7);
    setCustomId(`tkt_test_${randomSuffix}`);
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setLastOutcome(null);

    try {
      const res = await apiRequest<{
        ticket: TicketSummaryDTO;
        assignment_outcome: AssignmentOutcomeResponse | null;
      }>(`/api/companies/${companyId}/tickets`, {
        method: "POST",
        body: JSON.stringify({
          custom_id: customId.trim() || undefined,
          status,
          assign_immediately: assignImmediately,
        }),
      });

      if (res.assignment_outcome) {
        setLastOutcome(res.assignment_outcome);
      }

      setCustomId("");
      await loadTickets();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to create ticket.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignNow = async (ticketId: string) => {
    setActionTicketId(ticketId);
    setError(null);
    setLastOutcome(null);

    try {
      const outcome = await apiRequest<AssignmentOutcomeResponse>(
        "/api/assignments",
        {
          method: "POST",
          body: JSON.stringify({
            company_id: companyId,
            ticket_id: ticketId,
          }),
        },
      );

      setLastOutcome(outcome);
      await loadTickets();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to run assignment.",
      );
    } finally {
      setActionTicketId(null);
    }
  };

  const handleDeleteTicket = async (ticketId: string) => {
    setActionTicketId(ticketId);
    setError(null);

    try {
      await apiRequest(
        `/api/companies/${companyId}/tickets?ticketId=${encodeURIComponent(ticketId)}`,
        {
          method: "DELETE",
        },
      );

      setTickets((prev) => prev?.filter((t) => t.id !== ticketId) ?? null);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to delete ticket.",
      );
    } finally {
      setActionTicketId(null);
    }
  };

  return (
    <section className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">
              Reviewer Ticket Sandbox
            </h2>
            <Badge
              variant="outline"
              className="text-[10px] font-semibold uppercase tracking-wider text-primary border-primary/30 gap-1"
            >
              <SparklesIcon className="size-3" />
              Interactive Tester
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Create custom tickets on demand to test real-time assignment routing
            against availability windows and fairness rules.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-destructive/10 border border-destructive/20 p-3.5 text-sm text-destructive font-medium">
          <TriangleAlertIcon className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Main Sandbox Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left Column: Ticket Creation Form */}
        <Card className="border-border/80 shadow-xs lg:col-span-1">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <PlusIcon className="size-4 text-primary" />
              Create Custom Ticket
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-4">
            <form onSubmit={handleCreateTicket} className="flex flex-col gap-4">
              {/* Ticket ID Input */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="custom-ticket-id"
                  className="text-xs font-semibold text-foreground flex items-center justify-between"
                >
                  <span>Ticket ID</span>
                  <button
                    type="button"
                    onClick={handleAutoGenerateId}
                    className="text-[10px] font-normal text-primary hover:underline"
                  >
                    Auto Generate
                  </button>
                </label>
                <Input
                  id="custom-ticket-id"
                  placeholder="e.g. tkt_test_99"
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  className="font-mono text-xs"
                />
                <span className="text-[10px] text-muted-foreground">
                  Leave blank to auto-generate a unique ID.
                </span>
              </div>

              {/* Status Selector */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ticket-status-select"
                  className="text-xs font-semibold text-foreground"
                >
                  Initial Status
                </label>
                <select
                  id="ticket-status-select"
                  value={status}
                  onChange={(e) =>
                    setStatus(
                      e.target.value as
                        | "OPEN"
                        | "IN_PROGRESS"
                        | "WAITING"
                        | "RESOLVED"
                        | "CLOSED",
                    )
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="OPEN">OPEN (Default)</option>
                  <option value="IN_PROGRESS">IN_PROGRESS</option>
                  <option value="WAITING">WAITING</option>
                  <option value="RESOLVED">RESOLVED (Terminal)</option>
                  <option value="CLOSED">CLOSED (Terminal)</option>
                </select>
              </div>

              {/* Immediate Routing Toggle */}
              <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
                <input
                  type="checkbox"
                  id="assign-immediately"
                  checked={assignImmediately}
                  onChange={(e) => setAssignImmediately(e.target.checked)}
                  className="size-4 rounded text-primary accent-primary"
                />
                <label
                  htmlFor="assign-immediately"
                  className="text-xs font-medium leading-none cursor-pointer"
                >
                  Run Assignment Engine Immediately
                </label>
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="w-full gap-2 font-medium"
              >
                {submitting ? (
                  <RefreshCwIcon className="size-4 animate-spin" />
                ) : (
                  <PlusIcon className="size-4" />
                )}
                {assignImmediately
                  ? "Create & Route Ticket"
                  : "Create Ticket Only"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Right Column: Routing Outcome Banner & Ticket Roster */}
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Routing Decision Feedback Banner */}
          {lastOutcome && (
            <Card
              className={`border ${
                lastOutcome.status === "assigned"
                  ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/30"
                  : "border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30"
              }`}
            >
              <CardContent className="p-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {lastOutcome.status === "assigned" ? (
                      <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <ClockIcon className="size-5 text-amber-600 dark:text-amber-400 shrink-0" />
                    )}
                    <span className="text-sm font-bold">
                      {lastOutcome.status === "assigned"
                        ? `Ticket ${lastOutcome.ticket_id} Assigned!`
                        : `Ticket ${lastOutcome.ticket_id} Queued for Retry`}
                    </span>
                  </div>
                  <Badge
                    variant={
                      lastOutcome.status === "assigned"
                        ? "default"
                        : "secondary"
                    }
                    className="text-[10px] font-mono"
                  >
                    {lastOutcome.status.toUpperCase()}
                  </Badge>
                </div>

                {lastOutcome.status === "assigned" && lastOutcome.assignee && (
                  <div className="flex flex-col gap-1 pl-7 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">
                        Assigned To:
                      </span>
                      <span className="font-bold text-primary">
                        {lastOutcome.assignee.name} (
                        {lastOutcome.assignee.email})
                      </span>
                    </div>
                    {lastOutcome.explanation && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
                        <span className="font-semibold text-foreground">
                          Fairness Rule:
                        </span>
                        <Badge
                          variant="outline"
                          className="text-[10px] font-semibold border-primary/40 text-primary bg-primary/5"
                        >
                          {typeof lastOutcome.explanation === "object"
                            ? (DECIDED_BY_LABELS[
                                lastOutcome.explanation.decided_by
                              ] ?? lastOutcome.explanation.decided_by)
                            : String(lastOutcome.explanation)}
                        </Badge>
                        {typeof lastOutcome.explanation === "object" && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            (Active workload:{" "}
                            {lastOutcome.explanation.eligibility.active_tickets}{" "}
                            / {lastOutcome.explanation.eligibility.limit})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {lastOutcome.status === "pending" && (
                  <div className="flex flex-col gap-1 pl-7 text-xs text-muted-foreground">
                    <div>
                      <span className="font-semibold text-foreground">
                        Reason:
                      </span>{" "}
                      {lastOutcome.reason ?? lastOutcome.message}
                    </div>
                    {lastOutcome.next_retry_at && (
                      <div className="text-[11px] font-mono">
                        Next 5-min retry at:{" "}
                        {new Date(
                          lastOutcome.next_retry_at,
                        ).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Tickets Roster Table Card */}
          <Card className="border-border/80 shadow-xs">
            <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <TicketIcon className="size-4 text-primary" />
                Company Tickets ({tickets?.length ?? 0})
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadTickets()}
                className="gap-1.5 text-xs h-7"
              >
                <RefreshCwIcon className="size-3" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-4 flex flex-col gap-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : !tickets || tickets.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  No tickets created yet. Use the form on the left to create
                  test tickets.
                </div>
              ) : (
                <div className="divide-y divide-border/50 overflow-x-auto">
                  {tickets.map((t) => {
                    const isBusy = actionTicketId === t.id;
                    const isAssigned = !!t.assignee;
                    return (
                      <div
                        key={t.id}
                        className="flex items-center justify-between p-3.5 text-xs hover:bg-muted/30 transition-colors gap-3"
                      >
                        {/* Ticket ID & Status */}
                        <div className="flex items-center gap-3 min-w-[180px]">
                          <span className="font-mono font-bold text-foreground">
                            {t.id}
                          </span>
                          <Badge
                            variant={
                              t.status === "OPEN"
                                ? "outline"
                                : t.status === "RESOLVED" ||
                                    t.status === "CLOSED"
                                  ? "secondary"
                                  : "default"
                            }
                            className="text-[9px] font-mono py-0 px-1.5"
                          >
                            {t.status}
                          </Badge>
                        </div>

                        {/* Assignee Information */}
                        <div className="flex items-center gap-2 flex-1">
                          {isAssigned ? (
                            <div className="flex items-center gap-1.5 text-foreground font-medium">
                              <UserCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>{t.assignee?.name}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground italic text-[11px]">
                              Unassigned (Pending)
                            </span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => handleAssignNow(t.id)}
                            className="gap-1 text-[11px] h-7 px-2.5"
                          >
                            {isBusy ? (
                              <RefreshCwIcon className="size-3 animate-spin" />
                            ) : (
                              <SparklesIcon className="size-3 text-primary" />
                            )}
                            Route Ticket
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={isBusy}
                            onClick={() => handleDeleteTicket(t.id)}
                            className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            title="Delete Ticket"
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
