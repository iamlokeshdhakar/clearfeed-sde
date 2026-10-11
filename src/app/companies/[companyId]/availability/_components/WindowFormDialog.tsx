"use client";

import { AlertCircleIcon, MoonIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiClientError, apiRequest } from "@/lib/api-client";
import type { AgentDTO, AvailabilityWindowDTO } from "@/lib/api-types";
import {
  createAvailabilityWindowSchema,
  updateAvailabilityWindowSchema,
} from "@/lib/validation/availability";
import { TimezoneCombobox } from "./TimezoneCombobox";

function fieldErrorsFromIssues(
  issues: { path: PropertyKey[]; message: string }[],
) {
  const result: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    result[field] = issue.message;
  }
  return result;
}

const DAY_LABELS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

interface WindowFormDialogProps {
  companyId: string;
  agents: AgentDTO[];
  editingWindow: AvailabilityWindowDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function WindowFormDialog({
  companyId,
  agents,
  editingWindow,
  open,
  onOpenChange,
  onSaved,
}: WindowFormDialogProps) {
  const isEdit = editingWindow !== null;
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      return;
    }
    setGeneralError(null);
    setFieldErrors({});
    if (editingWindow) {
      setDaysOfWeek([editingWindow.day_of_week]);
      setStartTime(editingWindow.start_time);
      setEndTime(editingWindow.end_time);
      setTimezone(editingWindow.timezone);
      // Stale (removed) agents can't be resubmitted; dropping them here means
      // saving without touching the agent list clears the stale reference,
      // matching PRD §4.1 ("corrected" by editing the schedule).
      setAgentIds(
        editingWindow.agents
          .filter((agent) => !agent.is_stale)
          .map((agent) => agent.id),
      );
    } else {
      setDaysOfWeek([]);
      setStartTime("09:00");
      setEndTime("17:00");
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
      setAgentIds([]);
    }
  }, [open, editingWindow]);

  function toggleDay(day: number) {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  }

  function toggleAgent(agentId: string) {
    setAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setGeneralError(null);
    setFieldErrors({});

    if (isEdit) {
      const payload = {
        start_time: startTime,
        end_time: endTime,
        timezone,
        agent_ids: agentIds,
      };
      const parsed = updateAvailabilityWindowSchema.safeParse(payload);
      if (!parsed.success) {
        setFieldErrors(fieldErrorsFromIssues(parsed.error.issues));
        return;
      }
    } else {
      const payload = {
        days_of_week: daysOfWeek,
        start_time: startTime,
        end_time: endTime,
        timezone,
        agent_ids: agentIds,
      };
      const parsed = createAvailabilityWindowSchema.safeParse(payload);
      if (!parsed.success) {
        setFieldErrors(fieldErrorsFromIssues(parsed.error.issues));
        return;
      }
    }

    setSubmitting(true);
    try {
      if (isEdit) {
        await apiRequest(`/api/availability-windows/${editingWindow.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_time: startTime,
            end_time: endTime,
            timezone,
            agent_ids: agentIds,
          }),
        });
      } else {
        await apiRequest(`/api/companies/${companyId}/availability-windows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            days_of_week: daysOfWeek,
            start_time: startTime,
            end_time: endTime,
            timezone,
            agent_ids: agentIds,
          }),
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiClientError) {
        setGeneralError(error.message);
        const nextFieldErrors: Record<string, string> = {};
        for (const detail of error.details) {
          nextFieldErrors[detail.field] = detail.message;
        }
        setFieldErrors(nextFieldErrors);
      } else {
        setGeneralError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md rounded-2xl p-6 shadow-xl border-border/80">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-lg font-bold">
              {isEdit ? "Edit Availability Window" : "Add Availability Window"}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              Define the recurring work shift timing and assign available
              support agents.
            </p>
          </DialogHeader>

          {generalError && (
            <div className="flex items-center gap-2 rounded-xl bg-destructive/10 border border-destructive/20 p-3 text-xs font-medium text-destructive">
              <AlertCircleIcon className="size-4 shrink-0" />
              <span>{generalError}</span>
            </div>
          )}

          {/* Days Selection */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recurring Days
            </Label>
            {isEdit ? (
              <p className="text-sm font-medium text-foreground bg-muted/50 rounded-lg p-2.5 border">
                {
                  DAY_LABELS.find((d) => d.value === editingWindow.day_of_week)
                    ?.label
                }{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (create a new window to change day)
                </span>
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {DAY_LABELS.map((day) => {
                  const isChecked = daysOfWeek.includes(day.value);
                  return (
                    <label
                      key={day.value}
                      htmlFor={`day-${day.value}`}
                      className={`flex items-center gap-2.5 rounded-lg border p-2.5 text-xs font-medium cursor-pointer transition-all ${
                        isChecked
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/70 hover:border-border hover:bg-muted/30"
                      }`}
                    >
                      <Checkbox
                        id={`day-${day.value}`}
                        checked={isChecked}
                        onCheckedChange={() => toggleDay(day.value)}
                      />
                      <span className="font-normal">{day.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {fieldErrors.days_of_week && (
              <p className="text-xs font-medium text-destructive">
                {fieldErrors.days_of_week}
              </p>
            )}
          </div>

          {/* Start and End Times */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start_time" className="text-xs font-semibold">
                Start Time
              </Label>
              <Input
                id="start_time"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
                className="font-mono"
              />
              {fieldErrors.start_time && (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.start_time}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="end_time" className="text-xs font-semibold">
                End Time
              </Label>
              <Input
                id="end_time"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
                className="font-mono"
              />
              {fieldErrors.end_time && (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.end_time}
                </p>
              )}
            </div>
          </div>
          {startTime && endTime && startTime > endTime && (
            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 p-2.5 text-xs text-indigo-700 dark:text-indigo-300">
              <MoonIcon className="size-3.5 shrink-0" />
              <span>
                Overnight Window: shift wraps around to the next calendar day.
              </span>
            </div>
          )}

          {/* Timezone Selection */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="timezone" className="text-xs font-semibold">
              Shift Timezone
            </Label>
            <TimezoneCombobox
              id="timezone"
              value={timezone}
              onChange={setTimezone}
            />
            {fieldErrors.timezone && (
              <p className="text-xs font-medium text-destructive">
                {fieldErrors.timezone}
              </p>
            )}
          </div>

          {/* Agent Selection */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Assign Agents ({agentIds.length} selected)
              </Label>
            </div>

            {isEdit && editingWindow.agents.some((agent) => agent.is_stale) && (
              <div className="flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                <span>
                  This window contained removed agents; saving will clear stale
                  references.
                </span>
              </div>
            )}

            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3 border rounded-xl text-center">
                No active agents found for this company.
              </p>
            ) : (
              <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto rounded-xl border p-2.5">
                {agents.map((agent) => {
                  const isChecked = agentIds.includes(agent.id);
                  return (
                    <label
                      key={agent.id}
                      htmlFor={`agent-${agent.id}`}
                      className={`flex items-center justify-between rounded-lg p-2 text-xs cursor-pointer transition-colors ${
                        isChecked
                          ? "bg-primary/10 font-medium"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`agent-${agent.id}`}
                          checked={isChecked}
                          onCheckedChange={() => toggleAgent(agent.id)}
                        />
                        <span className="font-medium">{agent.name}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {agent.email}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {fieldErrors.agent_ids && (
              <p className="text-xs font-medium text-destructive">
                {fieldErrors.agent_ids}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                submitting ||
                (!isEdit && daysOfWeek.length === 0) ||
                agentIds.length === 0
              }
              className="text-xs font-semibold shadow-xs"
            >
              {submitting ? "Saving..." : "Save Window"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
