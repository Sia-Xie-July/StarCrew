// Time helpers for America/New_York, using only the built-in Intl API.
// Times are epoch milliseconds; dates are "YYYY-MM-DD" strings for the local evening.

export const TZ = "America/New_York";
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function parts(ms) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) {
    if (type !== "literal") p[type] = Number(value);
  }
  p.hour %= 24;
  return p;
}

function offsetMs(ms) {
  const p = parts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

const pad = (n) => String(n).padStart(2, "0");

/** Epoch ms for a New York wall-clock time on the given date. */
export function zoned(dateIso, hour, minute = 0) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  return guess - offsetMs(guess - offsetMs(guess));
}

export const hhmm = (ms) => { const p = parts(ms); return `${pad(p.hour)}:${pad(p.minute)}`; };
export const localDate = (ms) => { const p = parts(ms); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };

export function addDays(dateIso, n) {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

export const weekday = (dateIso) =>
  new Date(`${dateIso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

export const prettyDate = (dateIso) =>
  new Date(`${dateIso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** The "current night": before 08:00 local we are still in last night. */
export const tonight = (now = Date.now()) => localDate(now - 8 * HOUR);
