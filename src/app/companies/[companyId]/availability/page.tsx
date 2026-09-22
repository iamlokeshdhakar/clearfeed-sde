"use client";

import {
  CalendarIcon,
  ClockIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  TriangleAlertIcon,
  UserCheckIcon,
} from "lucide-react";
import { use, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError, apiRequest } from "@/lib/api-client";
import type { AgentDTO, AvailabilityWindowDTO } from "@/lib/api-types";
import { WindowFormDialog } from "./_components/WindowFormDialog";

const DAY_LABELS: { value: number; label: string; short: string }[] = [
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
  { value: 7, label: "Sunday", short: "Sun" },
];

export default function AvailabilityPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);
  const [windows, setWindows] = useState<AvailabilityWindowDTO[] | null>(null);
  const [agents, setAgents] = useState<AgentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tracked independently of windows/agents: if the initial request fails,
  // those stay null forever, and deriving `loading` from them would leave
  // the page stuck on skeletons with no way to recover.
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWindow, setEditingWindow] =
    useState<AvailabilityWindowDTO | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      setLoading(true);
      try {
        const [windowsRes, agentsRes] = await Promise.all([
          apiRequest<{ windows: AvailabilityWindowDTO[] }>(
            `/api/companies/${companyId}/availability-windows`,
            { signal },
          ),
          apiRequest<{ agents: AgentDTO[] }>(
            `/api/companies/${companyId}/agents`,
            { signal },
          ),
        ]);
        if (signal?.aborted) return;
        setWindows(windowsRes.windows);
        setAgents(agentsRes.agents);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : "Failed to load availability.",
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [companyId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setWindows(null);
    setAgents(null);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleDelete(windowId: string) {
    setDeletingId(windowId);
    setError(null);
    try {
      await apiRequest(`/api/availability-windows/${windowId}`, {
        method: "DELETE",
      });
      setWindows((prev) => prev?.filter((w) => w.id !== windowId) ?? null);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to delete window.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  const activeAgents =
    agents?.filter((agent) => agent.removed_at === null) ?? [];

  const staleWindowsCount = windows
    ? windows.filter((w) => w.agents.some((a) => a.is_stale)).length
    : 0;

  return (
    <section className="flex flex-col gap-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">
              Weekly Availability Board
            </h2>
            <Badge
              variant="outline"
              className="text-[10px] font-semibold uppercase tracking-wider text-primary border-primary/30"
            >
              7-Day Kanban View
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage weekly recurring shift schedules across Monday through Sunday
            columns.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingWindow(null);
            setDialogOpen(true);
          }}
          className="gap-2 font-medium shadow-xs"
        >
          <PlusIcon className="size-4" />
          Add Availability Window
        </Button>
      </div>

      {/* Summary Stat Cards */}
      {!loading && windows && agents && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CalendarIcon className="size-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">
                Total Windows
              </span>
              <span className="text-lg font-bold">
                {windows.length} schedule slots
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
            <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">
              <UserCheckIcon className="size-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">
                Active Team
              </span>
              <span className="text-lg font-bold">
                {activeAgents.length} agents
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
            <div
              className={`flex size-10 items-center justify-center rounded-lg ${staleWindowsCount > 0 ? "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"}`}
            >
              <TriangleAlertIcon className="size-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">
                Stale References
              </span>
              <span className="text-lg font-bold">
                {staleWindowsCount > 0
                  ? `${staleWindowsCount} flagged`
                  : "None"}
              </span>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/10 border border-destructive/20 p-3.5 text-sm text-destructive font-medium">
          <div className="flex items-center gap-2">
            <TriangleAlertIcon className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load()}
            disabled={loading}
            className="h-7 shrink-0 text-xs"
          >
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {DAY_LABELS.map((d) => (
            <Skeleton key={d.value} className="h-64 w-full rounded-xl" />
          ))}
        </div>
      ) : windows && agents ? (
        /* 7-Column Weekly Scrollable Kanban Board Grid */
        <div className="overflow-x-auto pb-4 timeline-scrollbar">
          <div className="grid grid-cols-7 gap-3.5 min-w-[1470px]">
            {DAY_LABELS.map((day) => {
              const dayWindows = windows.filter(
                (w) => w.day_of_week === day.value,
              );
              return (
                <div
                  key={day.value}
                  className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/20 p-3"
                >
                  {/* Column Header */}
                  <div className="flex items-center justify-between border-b border-border/50 pb-2 px-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                        {day.short}
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground">
                        ({day.label})
                      </span>
                    </div>
                    <Badge
                      variant={dayWindows.length > 0 ? "secondary" : "outline"}
                      className="text-[10px] font-mono px-1.5 py-0"
                    >
                      {dayWindows.length}
                    </Badge>
                  </div>

                  {/* Column Windows Stack */}
                  <div className="flex flex-col gap-2.5 min-h-[140px]">
                    {dayWindows.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-1 py-8 text-center border border-dashed rounded-xl bg-card/40">
                        <span className="text-[11px] text-muted-foreground">
                          No shifts
                        </span>
                      </div>
                    ) : (
                      dayWindows.map((window) => {
                        const isOvernight = window.start_time > window.end_time;
                        // Calculate shift duration
                        const [sH, sM] = window.start_time
                          .split(":")
                          .map(Number);
                        const [eH, eM] = window.end_time.split(":").map(Number);
                        const startMins = sH * 60 + sM;
                        let endMins = eH * 60 + eM;
                        if (endMins <= startMins) endMins += 24 * 60;
                        const durationMins = endMins - startMins;
                        const durH = Math.floor(durationMins / 60);
                        const durM = durationMins % 60;
                        const durationText =
                          durM === 0 ? `${durH}h` : `${durH}h ${durM}m`;

                        return (
                          <Card
                            key={window.id}
                            className="group relative border-border/80 bg-card shadow-2xs hover:shadow-md hover:border-primary/40 transition-all duration-200 overflow-hidden"
                          >
                            {/* Card Accent Border Top */}
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary/80 to-purple-500 opacity-80 group-hover:opacity-100 transition-opacity" />

                            <CardContent className="flex flex-col gap-2.5 p-3.5 pt-4">
                              {/* Shift Time & Quick Action Buttons */}
                              <div className="flex items-start justify-between gap-1.5">
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <ClockIcon className="size-3.5 text-primary shrink-0" />
                                    <span className="text-sm font-bold tracking-tight text-foreground font-mono">
                                      {window.start_time} – {window.end_time}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5 pl-5">
                                    <span className="text-[10px] font-medium text-muted-foreground bg-muted/60 px-1.5 py-0.2 rounded-md">
                                      {durationText} shift
                                    </span>
                                    {isOvernight && (
                                      <Badge
                                        variant="secondary"
                                        className="gap-0.5 bg-purple-50 text-purple-700 dark:bg-purple-950/70 dark:text-purple-300 text-[9px] font-medium py-0 px-1.5 border border-purple-200/50 dark:border-purple-800/50"
                                      >
                                        <MoonIcon className="size-2.5" />
                                        Overnight
                                      </Badge>
                                    )}
                                  </div>
                                </div>

                                <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100 transition-opacity">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                      setEditingWindow(window);
                                      setDialogOpen(true);
                                    }}
                                    className="size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                                    title="Edit Window"
                                  >
                                    <PencilIcon className="size-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={deletingId === window.id}
                                    onClick={() => handleDelete(window.id)}
                                    className="size-7 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                    title="Delete Window"
                                  >
                                    <TrashIcon className="size-3.5" />
                                  </Button>
                                </div>
                              </div>

                              {/* Timezone label */}
                              <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-1 pt-0.5">
                                <span
                                  className="truncate"
                                  title={window.timezone}
                                >
                                  🌍 {window.timezone}
                                </span>
                              </div>

                              {/* Assigned Agents List */}
                              <div className="flex flex-col gap-1.5 pt-2 border-t border-border/50">
                                <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                                  Assigned Agents ({window.agents.length})
                                </span>
                                {window.agents.length === 0 ? (
                                  <span className="text-[11px] text-muted-foreground italic">
                                    No agents assigned
                                  </span>
                                ) : (
                                  <div className="flex flex-wrap gap-1">
                                    {window.agents.map((agent) => {
                                      const initials = agent.name
                                        .split(" ")
                                        .map((n) => n[0])
                                        .join("")
                                        .toUpperCase()
                                        .slice(0, 2);
                                      return (
                                        <div
                                          key={agent.id}
                                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                                            agent.is_stale
                                              ? "border-rose-200 bg-rose-50/80 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
                                              : "border-border/80 bg-background text-foreground shadow-2xs"
                                          }`}
                                        >
                                          <span
                                            className={`flex size-4 items-center justify-center rounded-full text-[9px] font-bold ${
                                              agent.is_stale
                                                ? "bg-rose-200 text-rose-800 dark:bg-rose-900 dark:text-rose-200"
                                                : "bg-primary/15 text-primary"
                                            }`}
                                          >
                                            {initials}
                                          </span>
                                          <span className="truncate max-w-[100px]">
                                            {agent.name}
                                          </span>
                                          {agent.is_stale && (
                                            <span
                                              className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-rose-600 dark:text-rose-400"
                                              title="Agent was removed or inactive"
                                            >
                                              <TriangleAlertIcon className="size-2.5 shrink-0" />
                                              stale
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <WindowFormDialog
        companyId={companyId}
        agents={activeAgents}
        editingWindow={editingWindow}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => load()}
      />
    </section>
  );
}
