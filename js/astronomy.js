// Darkness and Moon calculations with Astronomy Engine (VSOP87 / ELP, ~1 arcminute accuracy).

import * as A from "astronomy-engine";
import { addDays, hhmm, zoned } from "./time.js";

export const STEP_MIN = 10;
export const ASTRO_DARK_DEG = -18; // Sun this far below the horizon = astronomical darkness
export const FAINT_MOON = 0.15;    // Moon less illuminated than this barely hurts the sky

function altitude(body, date, observer) {
  const eq = A.Equator(body, date, observer, true, true);
  return A.Horizon(date, observer, eq.ra, eq.dec, "normal").altitude;
}

export function phaseName(deg) {
  const names = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
    "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"];
  return names[Math.floor(((deg + 22.5) % 360) / 45)];
}

function windows(mask, samples) {
  const out = [];
  let start = null;
  mask.forEach((flag, i) => {
    if (flag && start === null) start = samples[i];
    else if (!flag && start !== null) { out.push([start, samples[i]]); start = null; }
  });
  if (start !== null) out.push([start, samples.at(-1)]);
  return out;
}

const hours = (ws) => Math.round(ws.reduce((s, [a, b]) => s + (b - a), 0) / 360e3) / 10;

/** Darkness and Moon conditions for the night that starts on `night` (local "YYYY-MM-DD"). */
export function nightReport(lat, lon, night) {
  const observer = new A.Observer(lat, lon, 0);
  const start = zoned(night, 16);
  const n = (16 * 60) / STEP_MIN + 1;
  const samples = Array.from({ length: n }, (_, i) => start + i * STEP_MIN * 60e3);

  const sunAlt = samples.map((t) => altitude(A.Body.Sun, new Date(t), observer));
  const moonAlt = samples.map((t) => altitude(A.Body.Moon, new Date(t), observer));

  const midnight = new Date(zoned(addDays(night, 1), 0));
  const illum = A.Illumination(A.Body.Moon, midnight).phase_fraction;
  const phase = A.MoonPhase(midnight);

  const dark = sunAlt.map((a) => a < ASTRO_DARK_DEG);
  const usable = dark.map((d, i) => d && (moonAlt[i] < 0 || illum < FAINT_MOON));

  const darkWindows = windows(dark, samples);
  const usableWindows = windows(usable, samples);
  const every = 30 / STEP_MIN;
  const timeline = [];
  for (let i = 0; i < n - 1; i += every) {
    timeline.push({ t: samples[i], dark: dark[i], moon_up: moonAlt[i] >= 0, usable: usable[i] });
  }

  return {
    date: night,
    dark_start: darkWindows.length ? hhmm(darkWindows[0][0]) : null,
    dark_end: darkWindows.length ? hhmm(darkWindows.at(-1)[1]) : null,
    dark_hours: hours(darkWindows),
    moon_illumination_pct: Math.round(illum * 100),
    moon_phase: phaseName(phase),
    moon_up_during_dark_hours: dark.some((d, i) => d && moonAlt[i] >= 0),
    usable_hours: hours(usableWindows),
    usable_windows: usableWindows.map(([a, b]) => [hhmm(a), hhmm(b)]),
    _usableWindows: usableWindows,
    _timeline: timeline,
  };
}
