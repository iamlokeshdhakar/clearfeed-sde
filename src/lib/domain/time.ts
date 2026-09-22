const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function timeStringToMinutes(value: string): number {
  const match = HH_MM_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid HH:mm time string: ${value}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour * 60 + minute;
}

export function minutesToTimeString(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export { HH_MM_PATTERN };
