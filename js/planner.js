// Deterministic ranking of (night, site) pairs. No LLM here; the agent calls these.

import { nightReport } from "./astronomy.js";
import { SITES_BY_ID, estimateDriveMinutes, sitesWithin } from "./sites.js";
import { addDays, hhmm, tonight, weekday } from "./time.js";
import { cloudsInWindows, fetchCloudCover } from "./weather.js";

const BORTLE_FACTOR = { 1: 1, 2: 1, 3: 1, 4: 0.9, 5: 0.75, 6: 0.55, 7: 0.4, 8: 0.25, 9: 0.15 };

export function verdict(cloudPct, conf, usableHours) {
  if (usableHours < 1) return "no-go (Moon or twilight)";
  if (cloudPct == null) return "too far out to forecast";
  if (cloudPct <= 30 && conf !== "low") return "go";
  if (cloudPct <= 60) return "maybe";
  return "no-go (clouds)";
}

export function score(usableHours, cloudPct, bortle) {
  if (cloudPct == null) return 0;
  return Math.round(usableHours * (1 - cloudPct / 100) * (BORTLE_FACTOR[bortle] ?? 0.5) * 100) / 100;
}

/** 30-minute steps across the night: darkness, Moon and mean cloud cover (all models). */
export function timelineWithClouds(timeline, series) {
  return timeline.map((step) => {
    const hour = step.t - (step.t % 3600e3);
    const vals = Object.values(series).filter((m) => m.has(hour)).map((m) => m.get(hour));
    return { ...step, t: hhmm(step.t), cloud_pct: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null };
  });
}

export function evaluate(site, night, series, withTimeline = false) {
  const { _usableWindows, _timeline, ...astro } = nightReport(site.lat, site.lon, night);
  const clouds = cloudsInWindows(series, _usableWindows);
  if (withTimeline) astro.timeline = timelineWithClouds(_timeline, series);
  return {
    date: night,
    weekday: weekday(night),
    site_id: site.id,
    site_name: site.name,
    town: site.town,
    bortle: site.bortle,
    drive_minutes_est: site.drive_minutes_est ?? null,
    ...astro,
    ...clouds,
    score: score(astro.usable_hours, clouds.cloud_pct, site.bortle),
    verdict: verdict(clouds.cloud_pct, clouds.confidence, astro.usable_hours),
  };
}

export async function rankNights(startLat, startLon, maxDriveMinutes = 120, nights = 7, firstNight = tonight()) {
  const sites = sitesWithin(startLat, startLon, maxDriveMinutes);
  if (!sites.length) return { options: [], nights: [], sites_considered: 0 };
  const series = await fetchCloudCover(sites.map((s) => [s.lat, s.lon]));
  const rows = [];
  sites.forEach((site, j) => {
    for (let i = 0; i < nights; i++) rows.push(evaluate(site, addDays(firstNight, i), series[j]));
  });
  rows.sort((a, b) => b.score - a.score);

  const best = {};
  for (const r of rows) if (!best[r.date] || r.score > best[r.date].score) best[r.date] = r;
  const keys = ["date", "weekday", "site_name", "usable_hours", "moon_illumination_pct",
    "cloud_pct", "confidence", "score", "verdict"];
  const nightSummary = Object.keys(best).sort().map((d) => Object.fromEntries(keys.map((k) => [k, best[d][k]])));
  return { options: rows, nights: nightSummary, sites_considered: sites.length };
}

export async function siteNightDetail(siteId, night, startLat = null, startLon = null) {
  const s = SITES_BY_ID[siteId];
  const site = { ...s };
  if (startLat != null && startLon != null) site.drive_minutes_est = estimateDriveMinutes(startLat, startLon, s);
  const [series] = await fetchCloudCover([[s.lat, s.lon]]);
  return { ...evaluate(site, night, series, true), note: s.note };
}
