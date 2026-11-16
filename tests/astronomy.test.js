// Astronomy checks against published values (USNO / timeanddate.com for Boston).
import assert from "node:assert/strict";
import { test } from "node:test";

import { nightReport } from "../js/astronomy.js";

const BOSTON = [42.3601, -71.0589];

test("full Moon is bright", () => {
  // Full Moon: 2025-12-04 23:14 UTC
  const r = nightReport(...BOSTON, "2025-12-04");
  assert.ok(r.moon_illumination_pct >= 98);
  assert.equal(r.moon_phase, "Full Moon");
});

test("new Moon leaves the whole night usable", () => {
  // New Moon: 2025-12-20 01:43 UTC
  const r = nightReport(...BOSTON, "2025-12-19");
  assert.ok(r.moon_illumination_pct <= 3);
  assert.equal(r.usable_hours, r.dark_hours);
});

test("winter solstice darkness times", () => {
  // Boston, 2025-12-21: astronomical dusk ~17:52 EST, dawn ~05:41 EST
  const r = nightReport(...BOSTON, "2025-12-21");
  assert.ok(r.dark_start >= "17:40" && r.dark_start <= "18:00", r.dark_start);
  assert.ok(r.dark_end >= "05:30" && r.dark_end <= "05:50", r.dark_end);
});

test("summer nights are short", () => {
  // Near the June solstice there are only ~4.5 h of astronomical darkness in Boston
  const r = nightReport(...BOSTON, "2026-06-21");
  assert.ok(r.dark_hours >= 3.5 && r.dark_hours <= 5.5, String(r.dark_hours));
});
