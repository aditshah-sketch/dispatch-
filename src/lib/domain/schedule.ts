// Timezone-aware weekly schedule. All instants are stored as UTC ISO strings;
// wall-clock times are interpreted in the workspace timezone (default
// Asia/Kolkata). Only the Wednesday 10 PM reminder is fixed by the case; the
// other times are editable defaults.

export interface ScheduleConfig {
  timezone: string;
  collectDays: number[]; // ISO weekdays, 1 = Monday
  collectTime: string; // HH:MM
  draftDay: number;
  draftTime: string;
  draftDeliveryTime: string; // same day as draftDay
  reminderTime: string; // same day as draftDay
  sendDay: number;
  sendTime: string;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  timezone: "Asia/Kolkata",
  collectDays: [1, 2, 3],
  collectTime: "08:00",
  draftDay: 3,
  draftTime: "15:00",
  draftDeliveryTime: "18:00",
  reminderTime: "22:00",
  sendDay: 4,
  sendTime: "09:00",
};

export const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // ISO 1..7
  ymd: string;
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday as string],
    ymd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

// Converts a wall-clock time in `timeZone` to a UTC Date. Handles DST zones by
// re-checking the offset at the resulting instant.
export function zonedTimeToUtc(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  const second = guess - offsetMinutes(new Date(result), timeZone) * 60000;
  if (second !== result) result = second;
  return new Date(result);
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

// The edition currently being produced: the next send day on or after today
// (in the workspace timezone). On send day itself, that day's edition.
export function currentPublishDate(now: Date, cfg: ScheduleConfig = DEFAULT_SCHEDULE): string {
  const today = zonedParts(now, cfg.timezone);
  const delta = (cfg.sendDay - today.weekday + 7) % 7;
  return addDays(today.ymd, delta);
}

function dayBefore(publishDate: string, sendDay: number, day: number): string {
  return addDays(publishDate, -((sendDay - day + 7) % 7));
}

export interface Milestones {
  publishDate: string;
  collectionWindowStart: string; // previous edition's send time
  collectRuns: string[];
  draftAt: string;
  draftDeliveryAt: string;
  reminderAt: string;
  sendAt: string;
}

export function milestonesFor(publishDate: string, cfg: ScheduleConfig = DEFAULT_SCHEDULE): Milestones {
  const tz = cfg.timezone;
  const draftDate = dayBefore(publishDate, cfg.sendDay, cfg.draftDay);
  return {
    publishDate,
    collectionWindowStart: zonedTimeToUtc(addDays(publishDate, -7), cfg.sendTime, tz).toISOString(),
    collectRuns: [...cfg.collectDays]
      .sort((a, b) => ((a - cfg.sendDay + 7) % 7) - ((b - cfg.sendDay + 7) % 7))
      .map((d) => zonedTimeToUtc(dayBefore(publishDate, cfg.sendDay, d), cfg.collectTime, tz).toISOString()),
    draftAt: zonedTimeToUtc(draftDate, cfg.draftTime, tz).toISOString(),
    draftDeliveryAt: zonedTimeToUtc(draftDate, cfg.draftDeliveryTime, tz).toISOString(),
    reminderAt: zonedTimeToUtc(draftDate, cfg.reminderTime, tz).toISOString(),
    sendAt: zonedTimeToUtc(publishDate, cfg.sendTime, tz).toISOString(),
  };
}

export function tzAbbreviation(timeZone: string, at = new Date()): string {
  if (timeZone === "Asia/Kolkata") return "IST";
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

export function formatInZone(
  iso: string | null | undefined,
  timeZone: string,
  style: "full" | "date" | "time" | "short" | "day" = "full",
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const tz = tzAbbreviation(timeZone, d);
  const opts: Intl.DateTimeFormatOptions =
    style === "date"
      ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
      : style === "day"
        ? { weekday: "long", day: "numeric", month: "long" }
        : style === "time"
          ? { hour: "numeric", minute: "2-digit" }
          : style === "short"
            ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }
            : { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  const text = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone, hour12: true }).format(d);
  return style === "date" || style === "day" ? text : `${text.replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM")} ${tz}`;
}

export function formatYmd(ymd: string, style: "long" | "short" = "long"): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: style === "long" ? "long" : "short",
    day: "numeric",
    month: style === "long" ? "long" : "short",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function isValidHHMM(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
