// Scoring, confidence, site filtering and time zones. No network needed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { score, verdict } from "../js/planner.js";
import { DEFAULT_START, sitesWithin } from "../js/sites.js";
import { hhmm, zoned } from "../js/time.js";
import { cloudsInWindows, confidence, parseHourly } from "../js/weather.js";

test("confidence comes from model agreement", () => {
  assert.equal(confidence(3, 5), "high");
  assert.equal(confidence(3, 25), "medium");
  assert.equal(confidence(3, 55), "low");
  assert.equal(confidence(1, 0), "low");
});

test("score prefers clear, dark sites", () => {
  assert.ok(score(6, 0, 3) > score(6, 0, 6));
  assert.ok(score(6, 10, 4) > score(6, 70, 4));
  assert.equal(score(6, null, 3), 0);
});

test("verdicts", () => {
  assert.equal(verdict(10, "high", 5), "go");
  assert.equal(verdict(10, "low", 5), "maybe");
  assert.equal(verdict(80, "high", 5), "no-go (clouds)");
  assert.equal(verdict(0, "high", 0.5), "no-go (Moon or twilight)");
  assert.equal(verdict(null, "none", 5), "too far out to forecast");
});

test("sites are filtered by drive time and sorted", () => {
  const near = sitesWithin(DEFAULT_START.lat, DEFAULT_START.lon, 45);
  const far = sitesWithin(DEFAULT_START.lat, DEFAULT_START.lon, 180);
  assert.deepEqual(near.map((s) => s.id), ["blue-hills"]);
  assert.equal(far.length, 12);
  assert.deepEqual(far, [...far].sort((a, b) => a.drive_minutes_est - b.drive_minutes_est));
});

test("New York wall-clock times survive daylight-saving changes", () => {
  assert.equal(new Date(zoned("2026-07-04", 22)).toISOString(), "2026-07-05T02:00:00.000Z"); // EDT
  assert.equal(new Date(zoned("2026-12-04", 22)).toISOString(), "2026-12-05T03:00:00.000Z"); // EST
  assert.equal(hhmm(zoned("2026-11-16", 23, 30)), "23:30");
});

test("clouds only count the usable hours", () => {
  const t = (h) => zoned("2026-11-16", h) / 1000;
  const series = parseHourly({
    time: [t(21), t(22), t(23)],
    cloud_cover_gfs_seamless: [100, 0, 0],
    cloud_cover_ecmwf_ifs025: [100, 10, 10],
    cloud_cover_icon_seamless: [100, 20, 20],
  });
  const c = cloudsInWindows(series, [[zoned("2026-11-16", 22), zoned("2026-11-17", 0)]]);
  assert.equal(c.cloud_pct, 10);
  assert.equal(c.spread, 20);
  assert.equal(c.confidence, "medium");
});
