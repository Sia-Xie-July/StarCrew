// Hourly cloud cover from several Open-Meteo weather models, plus a confidence level.

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const MODELS = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless"];
export const MODEL_LABELS = { gfs_seamless: "GFS (US)", ecmwf_ifs025: "ECMWF (EU)", icon_seamless: "ICON (DE)" };
const CACHE_TTL_MS = 30 * 60e3;

const cache = new Map();

/** One request for all points. Returns, per point, { model: Map(epoch ms -> cloud %) }. */
export async function fetchCloudCover(points, days = 8) {
  const key = JSON.stringify([points.map(([a, b]) => [a.toFixed(3), b.toFixed(3)]), days]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const params = new URLSearchParams({
    latitude: points.map((p) => p[0]).join(","),
    longitude: points.map((p) => p[1]).join(","),
    hourly: "cloud_cover",
    models: MODELS.join(","),
    forecast_days: String(days),
    timeformat: "unixtime",
    timezone: "GMT",
  });
  const resp = await fetch(`${FORECAST_URL}?${params}`);
  if (!resp.ok) throw new Error(`Open-Meteo forecast failed (${resp.status})`);
  let data = await resp.json();
  if (!Array.isArray(data)) data = [data];
  const value = data.map((d) => parseHourly(d.hourly));
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function parseHourly(hourly) {
  const times = hourly.time.map((s) => s * 1000);
  const out = {};
  for (const model of MODELS) {
    const values = hourly[`cloud_cover_${model}`];
    if (!values) continue;
    const m = new Map();
    times.forEach((t, i) => { if (values[i] != null) m.set(t, values[i]); });
    out[model] = m;
  }
  return out;
}

export function confidence(nModels, spread) {
  if (nModels < 2) return "low";
  if (spread <= 15) return "high";
  if (spread <= 30) return "medium";
  return "low";
}

/** Mean cloud cover per model over the hours that fall inside the given windows (epoch ms). */
export function cloudsInWindows(series, windows) {
  const perModel = {};
  for (const [model, values] of Object.entries(series)) {
    const picked = [];
    for (const [t, v] of values) if (windows.some(([a, b]) => a <= t && t < b)) picked.push(v);
    if (picked.length) perModel[model] = Math.round(picked.reduce((s, v) => s + v, 0) / picked.length);
  }
  const means = Object.values(perModel);
  if (!means.length) return { cloud_pct: null, per_model: {}, spread: null, confidence: "none" };
  const spread = Math.max(...means) - Math.min(...means);
  return {
    cloud_pct: Math.round(means.reduce((s, v) => s + v, 0) / means.length),
    per_model: Object.fromEntries(Object.entries(perModel).map(([m, v]) => [MODEL_LABELS[m], v])),
    spread,
    confidence: confidence(means.length, spread),
  };
}

export async function geocode(place, count = 5) {
  const resp = await fetch(`${GEOCODE_URL}?${new URLSearchParams({ name: place, count: String(count) })}`);
  if (!resp.ok) throw new Error(`Geocoding failed (${resp.status})`);
  const data = await resp.json();
  return (data.results || []).map((r) => ({
    name: r.name, region: r.admin1, country: r.country, lat: r.latitude, lon: r.longitude,
  }));
}
