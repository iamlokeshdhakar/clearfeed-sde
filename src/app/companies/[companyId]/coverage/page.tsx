"use client";

import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  InfoIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { DateTime } from "luxon";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError, apiRequest } from "@/lib/api-client";
import type { CoverageResultDTO } from "@/lib/api-types";

const DAY_LABELS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

const PX_PER_MINUTE = 0.65;

type Block = {
  kind: "covered" | "gap";
  day_of_week: number;
  start: string;
  end: string;
  agent_ids?: string[];
  duration_minutes?: number;
};

function formatLocal(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { setZone: true })
    .setZone(timezone)
    .toFormat("HH:mm");
}

export default function CoveragePage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const [coverage, setCoverage] = useState<CoverageResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const qs = weekStart ? `?week_start=${weekStart}` : "";
        const result = await apiRequest<CoverageResultDTO>(
          `/api/companies/${companyId}/coverage${qs}`,
          { signal },
        );
        if (signal?.aborted) return;
        setCoverage(result);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : "Failed to load coverage.",
        );
      }
    },
    [companyId, weekStart],
  );

  useEffect(() => {
    const controller = new AbortController();
    setCoverage(null);
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function shiftWeek(offsetWeeks: number) {
    const base = coverage
      ? DateTime.fromISO(coverage.week_start, { setZone: true })
      : DateTime.now();
    setWeekStart(base.plus({ weeks: offsetWeeks }).toFormat("yyyy-LL-dd"));
  }

  const blocksByDay = useMemo(() => {
    if (!coverage) return new Map<number, Block[]>();
    const blocks: Block[] = [
      ...coverage.covered.map((c) => ({ ...c, kind: "covered" as const })),
      ...coverage.gaps.map((g) => ({ ...g, kind: "gap" as const })),
    ].sort((a, b) => a.start.localeCompare(b.start));

    const map = new Map<number, Block[]>();
    for (const block of blocks) {
      const list = map.get(block.day_of_week) ?? [];
      list.push(block);
      map.set(block.day_of_week, list);
    }
    return map;
  }, [coverage]);

  const loading = coverage === null && error === null;

  return (
    <section className="flex flex-col gap-6">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            Support Coverage Gaps
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Identify periods inside required company support hours where no
            active agent availability exists.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => shiftWeek(-1)}
            className="h-8 gap-1 text-xs"
          >
            <ChevronLeftIcon className="size-3.5" />
            Previous
          </Button>
          <Input
            type="date"
            className="h-8 w-auto text-xs font-mono"
            value={
              weekStart ?? (coverage ? coverage.week_start.slice(0, 10) : "")
            }
            onChange={(e) => setWeekStart(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => shiftWeek(1)}
            className="h-8 gap-1 text-xs"
          >
            Next
            <ChevronRightIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeekStart(undefined)}
            className="h-8 text-xs font-medium text-primary"
          >
            This week
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-destructive/10 border border-destructive/20 p-3.5 text-sm text-destructive font-medium">
          <TriangleAlertIcon className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : coverage ? (
        <>
          {/* Summary Stat Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
              <div
                className={`flex size-10 items-center justify-center rounded-lg ${coverage.total_gap_minutes === 0 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400" : "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"}`}
              >
                {coverage.total_gap_minutes === 0 ? (
                  <ShieldCheckIcon className="size-5" />
                ) : (
                  <TriangleAlertIcon className="size-5" />
                )}
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-medium text-muted-foreground">
                  Coverage Gaps
                </span>
                <span className="text-lg font-bold">
                  {coverage.total_gap_minutes === 0
                    ? "100% Covered"
                    : `${coverage.total_gap_minutes} min unstaffed`}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ClockIcon className="size-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-medium text-muted-foreground">
                  Required Intervals
                </span>
                <span className="text-lg font-bold">
                  {coverage.required.length} slots
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
              <div className="flex size-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                <CalendarIcon className="size-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-medium text-muted-foreground">
                  Reference Week
                </span>
                <span className="text-sm font-semibold font-mono">
                  {coverage.week_start.slice(0, 10)} to{" "}
                  {coverage.week_end.slice(0, 10)}
                </span>
              </div>
            </div>
          </div>

          {/* Timeline Visualizer Card */}
          <Card className="border-border/80">
            <CardContent className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <InfoIcon className="size-3.5 text-primary" />
                  <span>
                    Times displayed in company support timezone:{" "}
                    <span className="font-semibold text-foreground font-mono">
                      {coverage.timezone}
                    </span>
                  </span>
                </div>
                {/* Timeline Legend */}
                <div className="flex items-center gap-4 text-xs font-medium">
                  <div className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-emerald-500" />
                    <span>Agent Covered</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-rose-500" />
                    <span>Uncovered Gap</span>
                  </div>
                </div>
              </div>

              {/* Day Visual Rows */}
              <div className="flex flex-col gap-3 timeline-scrollbar overflow-x-auto pb-2 pt-1">
                {DAY_LABELS.map((day) => {
                  const dayBlocks = blocksByDay.get(day.value) ?? [];
                  return (
                    <div
                      key={day.value}
                      className="flex items-center gap-4 min-w-[580px]"
                    >
                      <span className="w-24 shrink-0 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                        {day.label}
                      </span>
                      <div className="flex min-h-9 flex-1 items-stretch gap-1 rounded-lg bg-muted/30 p-1 border border-border/40">
                        {dayBlocks.length === 0 ? (
                          <span className="text-muted-foreground/60 text-xs italic px-2 self-center">
                            No required support hours configured
                          </span>
                        ) : (
                          dayBlocks.map((block, index) => {
                            const duration = DateTime.fromISO(block.end).diff(
                              DateTime.fromISO(block.start),
                              "minutes",
                            ).minutes;
                            const isCovered = block.kind === "covered";
                            const agentCount = block.agent_ids?.length ?? 0;
                            const timeRangeStr = `${formatLocal(block.start, coverage.timezone)} - ${formatLocal(block.end, coverage.timezone)}`;

                            return (
                              <div
                                key={`${block.start}-${index}`}
                                title={`${timeRangeStr} · ${isCovered ? `${agentCount} active agent(s)` : "Uncovered gap"}`}
                                style={{
                                  width: `${Math.max(duration * PX_PER_MINUTE, 6)}px`,
                                }}
                                className={`group relative flex items-center justify-center rounded-md text-[10px] font-mono font-medium transition-all duration-150 ${
                                  isCovered
                                    ? "bg-emerald-500/80 text-white hover:bg-emerald-600 shadow-xs"
                                    : "bg-rose-500/90 text-white hover:bg-rose-600 animate-pulse shadow-xs"
                                }`}
                              >
                                <span className="truncate px-1 opacity-90 group-hover:opacity-100">
                                  {duration >= 60 ? `${timeRangeStr}` : ""}
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Coverage Gaps Detailed List */}
          <div className="flex flex-col gap-3">
            <h3 className="text-base font-bold tracking-tight">
              Uncovered Gap Breakdown ({coverage.gaps.length} gaps ·{" "}
              {coverage.total_gap_minutes} mins)
            </h3>

            {coverage.gaps.length === 0 ? (
              <Card className="border-emerald-500/30 bg-emerald-500/5">
                <CardContent className="flex items-center gap-3 p-4 text-emerald-800 dark:text-emerald-300">
                  <ShieldCheckIcon className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-semibold">
                    Perfect Support Coverage! All required support hours have
                    active agent availability scheduled.
                  </span>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {coverage.gaps.map((gap, index) => {
                  const dayName = DAY_LABELS.find(
                    (d) => d.value === gap.day_of_week,
                  )?.label;
                  return (
                    <div
                      key={`${gap.start}-${index}`}
                      className="flex items-center justify-between rounded-xl border border-rose-200 dark:border-rose-950/60 bg-rose-50/50 dark:bg-rose-950/20 px-4 py-3 text-xs"
                    >
                      <div className="flex items-center gap-2.5">
                        <TriangleAlertIcon className="size-4 text-rose-600 dark:text-rose-400 shrink-0" />
                        <div>
                          <span className="font-bold text-foreground">
                            {dayName}:{" "}
                          </span>
                          <span className="font-mono font-medium">
                            {formatLocal(gap.start, coverage.timezone)} -{" "}
                            {formatLocal(gap.end, coverage.timezone)}
                          </span>
                        </div>
                      </div>
                      <Badge
                        variant="destructive"
                        className="font-mono text-xs"
                      >
                        {gap.duration_minutes} mins gap
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
