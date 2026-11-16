// Provider-independent agent pieces: the system prompt, the tools, the call recorder and
// the step that turns the model's decision into verified pick cards. Used by the Claude
// client in the browser (agent.js) and the Gemini server (server/gemini.js).

import * as planner from "./planner.js";
import { SITES_BY_ID, sitesWithin } from "./sites.js";
import { addDays, prettyDate, tonight, weekday } from "./time.js";
import * as weather from "./weather.js";

export const MAX_ITERATIONS = 12;

/** First lines of the user turn: today's date and the start point. */
export function contextLine(start) {
  const today = tonight();
  return `Tonight is ${weekday(today)} ${today} (the 7-night horizon ends ${addDays(today, 6)}). ` +
    `Default start point: ${start.label} (${start.lat}, ${start.lon}).`;
}

export const SYSTEM_PROMPT = `You are StarCrew, a stargazing trip planner for people in the Boston area.

How you work:
- Every fact you state (cloud cover, Moon, darkness times, drive times, site names) must come from a tool result in this conversation. Never estimate or recall these numbers yourself.
- Start with forecast_nights to rank nights and sites. Use site_night_detail to double-check your top pick. Use geocode only if the user names a start point other than the default.
- Prefer nights with more usable dark hours, low cloud cover and high model agreement. If the models disagree (low confidence), say so plainly.
- Drive times are straight-line estimates; say "about". Remind people to check park hours.

When you have decided, call submit_plan exactly once with:
- summary: one sentence with the recommendation.
- picks: the top pick first, then up to two backups (ideally a different night and a different site). For each pick give 2-3 short "why" reasons that cite tool numbers.
- group_message: a ready-to-paste group-chat message starting with "📣" (night, site, meet time, what to bring).
After submit_plan, reply with at most two sentences. The app shows the picks, so do not repeat them.`;

const COMPACT_KEYS = ["date", "weekday", "site_id", "site_name", "town", "bortle", "drive_minutes_est",
  "dark_start", "dark_end", "usable_hours", "usable_windows", "moon_illumination_pct",
  "moon_phase", "cloud_pct", "per_model", "confidence", "score", "verdict"];
export const compact = (row) => Object.fromEntries(COMPACT_KEYS.map((k) => [k, row[k] ?? null]));
const json = (obj) => JSON.stringify(obj);

/** Keeps every tool call of one request so each pick can cite its sources. */
export class Recorder {
  constructor() {
    this.calls = [];
    this.pending = [];   // events not yet sent to the UI
    this.ranking = [];   // full ranking from the latest forecast_nights
    this.submitted = {};
  }

  record(name, input, output, summary, by = "agent") {
    const call = { seq: this.calls.length + 1, name, input, output, summary, by };
    this.calls.push(call);
    this.pending.push({ type: "tool_result", ...call });
    return call.seq;
  }

  drain() {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/** Tool definitions (name, description, JSON schema, run) shared by every model provider. */
export function toolSpecs(rec, start) {
  const geocode = ({
    name: "geocode",
    description: "Look up the latitude and longitude of a place name.",
    input_schema: {
      type: "object",
      properties: { place: { type: "string", description: 'A town, neighborhood or landmark, e.g. "Somerville, MA".' } },
      required: ["place"],
      additionalProperties: false,
    },
    run: async ({ place }) => {
      const results = await weather.geocode(place);
      const us = (results.filter((r) => r.country === "United States").length
        ? results.filter((r) => r.country === "United States") : results).slice(0, 3);
      rec.record("geocode", { place }, us, `${us.length} match(es) for "${place}"`);
      return json(us);
    },
  });

  const listDarkSites = ({
    name: "list_dark_sites",
    description: "List curated dark-sky sites within an estimated drive time of the start point.",
    input_schema: {
      type: "object",
      properties: {
        start_lat: { type: "number", description: "Latitude of the starting point." },
        start_lon: { type: "number", description: "Longitude of the starting point." },
        max_drive_minutes: { type: "integer", description: "Maximum one-way drive in minutes." },
      },
      required: ["start_lat", "start_lon", "max_drive_minutes"],
      additionalProperties: false,
    },
    run: async (input) => {
      const found = sitesWithin(input.start_lat, input.start_lon, input.max_drive_minutes);
      rec.record("list_dark_sites", input, found, `${found.length} sites within ~${input.max_drive_minutes} min`);
      return json(found);
    },
  });

  const forecastNights = ({
    name: "forecast_nights",
    description: "Rank every (night, site) pair for the coming nights by usable dark hours, cloud cover and site darkness. " +
      "Combines astronomy (darkness, Moon) with cloud forecasts from three weather models (GFS, ECMWF, ICON). " +
      "Returns the best site per night and the top 8 options overall.",
    input_schema: {
      type: "object",
      properties: {
        max_drive_minutes: { type: "integer", description: "Maximum one-way drive in minutes (default 120)." },
        nights: { type: "integer", description: "How many nights ahead to consider, 1 to 7 (default 7)." },
        start_lat: { type: "number", description: "Start latitude; defaults to the user's start point." },
        start_lon: { type: "number", description: "Start longitude; defaults to the user's start point." },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      const maxDrive = input.max_drive_minutes ?? 120;
      const nights = Math.max(1, Math.min(Math.trunc(input.nights ?? 7), 7));
      const lat = input.start_lat ?? start.lat;
      const lon = input.start_lon ?? start.lon;
      const result = await planner.rankNights(lat, lon, maxDrive, nights);
      rec.ranking = result.options;
      const top = result.options.slice(0, 8).map(compact);
      const out = { best_per_night: result.nights, top_options: top };
      rec.record("forecast_nights", { max_drive_minutes: maxDrive, nights, start_lat: lat, start_lon: lon }, out,
        top.length ? `${result.sites_considered} sites × ${nights} nights ranked; best: ${top[0].weekday} ${top[0].date} at ${top[0].site_name}`
          : "no sites in range");
      return json(out);
    },
  });

  const siteNightDetail = ({
    name: "site_night_detail",
    description: "Full detail for one site on one night: darkness windows, Moon, per-model cloud cover.",
    input_schema: {
      type: "object",
      properties: {
        site_id: { type: "string", description: 'Site id from forecast_nights or list_dark_sites, e.g. "douglas".' },
        night_date: { type: "string", description: "The evening's date as YYYY-MM-DD." },
      },
      required: ["site_id", "night_date"],
      additionalProperties: false,
    },
    run: async ({ site_id, night_date }) => {
      if (!SITES_BY_ID[site_id]) return json({ error: `unknown site_id "${site_id}"`, valid: Object.keys(SITES_BY_ID) });
      const row = await planner.siteNightDetail(site_id, night_date, start.lat, start.lon);
      const out = { ...compact(row), note: row.note };
      rec.record("site_night_detail", { site_id, night_date }, out,
        `${row.site_name} ${night_date}: ${row.cloud_pct}% cloud, ${row.usable_hours} h usable, confidence ${row.confidence}`);
      return json(out);
    },
  });

  const submitPlan = ({
    name: "submit_plan",
    description: "Record the final plan so the app can show it as cards. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One sentence with the recommendation." },
        picks: {
          type: "array",
          description: "Top pick first, then up to two backups.",
          items: {
            type: "object",
            properties: {
              night_date: { type: "string", description: "Evening date, YYYY-MM-DD." },
              site_id: { type: "string" },
              window_start: { type: "string", description: "HH:MM local time." },
              window_end: { type: "string", description: "HH:MM local time." },
              why: { type: "array", items: { type: "string" }, description: "2-3 short reasons citing tool numbers." },
            },
            required: ["night_date", "site_id", "window_start", "window_end", "why"],
            additionalProperties: false,
          },
        },
        group_message: { type: "string", description: 'Ready-to-paste group-chat message starting with "📣".' },
      },
      required: ["summary", "picks", "group_message"],
      additionalProperties: false,
    },
    run: async (input) => {
      rec.submitted = input;
      rec.record("submit_plan", { picks: input.picks.length }, input, `${input.picks.length} pick(s) submitted`);
      return "Plan recorded. Reply with at most two sentences.";
    },
  });

  return [geocode, listDarkSites, forecastNights, siteNightDetail, submitPlan];
}

// ---------- turning the agent's decision into cards ----------

function longest(windows) {
  if (!windows?.length) return ["?", "?"];
  const minutes = ([a, b]) => {
    const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    return (m(b) - m(a) + 1440) % 1440;
  };
  return windows.reduce((best, w) => (minutes(w) > minutes(best) ? w : best));
}

export function factBullets(d) {
  const windows = (d.usable_windows || []).map(([a, b]) => `${a}–${b}`).join(", ") || "none";
  const models = Object.entries(d.per_model || {}).map(([k, v]) => `${k.split(" ")[0]} ${v}%`).join(", ");
  const facts = [`${d.usable_hours} h of usable darkness (${windows}); full darkness ${d.dark_start}–${d.dark_end}`];
  facts.push(d.cloud_pct != null
    ? `${d.cloud_pct}% cloud cover over those hours (${models}) → ${d.confidence} confidence`
    : "Beyond the cloud forecast range");
  facts.push(`Moon ${d.moon_illumination_pct}% lit (${d.moon_phase})`);
  facts.push(`Bortle ${d.bortle} sky, about ${d.drive_minutes_est ?? "?"} min drive`);
  return facts;
}

/** Top option, then the best on a different night, then the best at a different site. */
export function fallbackPicks(ranking) {
  if (!ranking.length) return [];
  const first = ranking[0];
  const picks = [first];
  const otherNight = ranking.find((r) => r.date !== first.date);
  if (otherNight) picks.push(otherNight);
  const otherSite = ranking.find((r) => r.date === first.date && !picks.some((p) => p.site_id === r.site_id));
  if (otherSite) picks.push(otherSite);
  return picks.map((r) => {
    const [a, b] = longest(r.usable_windows);
    return { night_date: r.date, site_id: r.site_id, window_start: a, window_end: b, why: [] };
  });
}

function relevant(call, siteId, night) {
  if (["forecast_nights", "list_dark_sites", "geocode", "submit_plan"].includes(call.name)) return true;
  return call.name === "site_night_detail" && call.input.site_id === siteId && call.input.night_date === night;
}

export async function buildPlan(rec, start, maxDrive = 120) {
  const source = rec.submitted.picks?.length ? "agent" : "ranking";
  let raw = rec.submitted.picks || [];
  if (!raw.length) {
    if (!rec.ranking.length) { // the model called no forecast at all: rank ourselves
      const result = await planner.rankNights(start.lat, start.lon, maxDrive, 7);
      rec.ranking = result.options;
      rec.record("forecast_nights", { max_drive_minutes: maxDrive, nights: 7 },
        { top_options: result.options.slice(0, 8).map(compact) },
        "ranked by StarCrew (the model skipped this step)", "app");
    }
    raw = fallbackPicks(rec.ranking);
  }

  const labels = ["Top pick", "Backup", "Backup"];
  const picks = [];
  for (const p of raw.slice(0, 3)) {
    const siteId = p.site_id, night = p.night_date;
    if (!SITES_BY_ID[siteId] || !/^\d{4}-\d{2}-\d{2}$/.test(night || "")) continue;
    const d = await planner.siteNightDetail(siteId, night, start.lat, start.lon);
    const seq = rec.record("site_night_detail", { site_id: siteId, night_date: night },
      { ...compact(d), note: d.note }, `verified ${d.site_name} on ${night}`, "app");
    const w = p.window_start && p.window_end ? [p.window_start, p.window_end] : longest(d.usable_windows);
    picks.push({
      rank: picks.length + 1, label: labels[picks.length],
      night_date: night, weekday: d.weekday, site_id: siteId, site_name: d.site_name, town: d.town,
      window: `${w[0]}–${w[1]}`,
      why: (p.why || []).filter((s) => typeof s === "string").slice(0, 4),
      facts: factBullets(d), note: d.note, detail: d,
      sources: [...rec.calls.filter((c) => c.seq !== seq && relevant(c, siteId, night)).map((c) => c.seq), seq],
    });
  }

  const top = picks[0];
  const when = top ? prettyDate(top.night_date).replace(",", "") : "";
  const summary = rec.submitted.summary || (top
    ? `Best bet: ${when} at ${top.site_name} (${top.window}), ${top.detail.cloud_pct}% cloud, ${top.detail.confidence} confidence.`
    : "No usable night found.");
  const group = rec.submitted.group_message || (top
    ? `📣 Stargazing ${when} at ${top.site_name} (${top.town})! Best sky ${top.window}. ` +
      `Bring warm layers, a red flashlight and snacks. Drive is about ${top.detail.drive_minutes_est} min; check park hours.`
    : "");
  return { source, summary, group_message: group, picks };
}
