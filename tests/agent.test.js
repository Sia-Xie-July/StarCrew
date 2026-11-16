// Agent loop with a scripted fake Claude API: no key, no credit. Weather and astronomy
// are real, so this needs network access to Open-Meteo.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Recorder, buildPlan, fallbackPicks, runPlan } from "../js/agent.js";
import { addDays, tonight } from "../js/time.js";

const night = addDays(tonight(), 1);

const SCRIPT = [
  [{ type: "tool_use", id: "t1", name: "forecast_nights", input: { max_drive_minutes: 120, nights: 3 } }],
  [{ type: "tool_use", id: "t2", name: "submit_plan", input: {
    summary: "Go to Douglas.", group_message: "📣 Stargazing!",
    picks: [
      { night_date: night, site_id: "douglas", window_start: "22:40", window_end: "05:10", why: ["models agree"] },
      { night_date: night, site_id: "not-a-site", window_start: "22:00", window_end: "04:00", why: ["dropped"] },
    ],
  } }],
  [{ type: "text", text: "Have fun out there." }],
];

function fakeApi(seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), headers: new Headers(init.headers), body });
    const content = SCRIPT[seen.length - 1];
    return new Response(JSON.stringify({
      id: `msg_${seen.length}`, type: "message", role: "assistant", model: body.model, content,
      stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("agent streams tool calls, then a verified plan with sources", async () => {
  const seen = [];
  const events = [];
  await runPlan({ apiKey: "sk-ant-test", request: "best night?", onEvent: (e) => events.push(e),
    clientOptions: { fetch: fakeApi(seen) } });

  const types = events.map((e) => e.type);
  assert.equal(types.at(-1), "done", JSON.stringify(events.filter((e) => e.type === "error")));
  assert.deepEqual(events.filter((e) => e.type === "tool_call").map((e) => e.name), ["forecast_nights", "submit_plan"]);

  const { plan } = events.find((e) => e.type === "plan");
  assert.equal(plan.source, "agent");
  assert.equal(plan.picks.length, 1); // the invalid site id was dropped
  const [pick] = plan.picks;
  assert.equal(pick.site_name, "Douglas State Forest");
  assert.equal(pick.window, "22:40–05:10");
  assert.deepEqual(pick.why, ["models agree"]);
  assert.ok(pick.facts.length >= 3);

  const results = Object.fromEntries(events.filter((e) => e.type === "tool_result").map((e) => [e.seq, e]));
  const names = new Set(pick.sources.map((s) => results[s].name));
  assert.ok(names.has("forecast_nights") && names.has("site_night_detail"));
  assert.equal(results[pick.sources.at(-1)].by, "app"); // StarCrew re-verified the pick
  assert.equal(events.find((e) => e.type === "usage").input_tokens, 300);

  const first = seen[0];
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.equal(first.body.fallbacks, "default");
  assert.deepEqual(first.body.output_config, { effort: "medium" });
  assert.equal(first.headers.get("authorization"), "Bearer sk-ant-test");
  // tool results went back to Claude in the next request
  assert.equal(seen[1].body.messages.at(-1).content[0].type, "tool_result");
});

test("local Ollama requests only carry CORS-safe headers", async () => {
  const seen = [];
  await runPlan({ apiKey: null, request: "best night?", model: "ollama/qwen3:8b", onEvent: () => {},
    clientOptions: { fetch: fakeApi(seen) } });
  assert.ok(seen[0].url.startsWith("http://localhost:11434/"));
  assert.equal(seen[0].body.model, "qwen3:8b");
  assert.deepEqual(seen[0].body.thinking, { type: "disabled" });
  for (const name of seen[0].headers.keys()) assert.ok(!name.startsWith("anthropic-") && name !== "x-api-key", name);
});

test("fallback picks when the model skips submit_plan", async () => {
  const row = { date: night, site_id: "douglas", usable_windows: [["22:40", "05:10"]] };
  const rows = [row, { ...row, date: addDays(night, 1) }, { ...row, site_id: "wachusett" }];
  assert.deepEqual(fallbackPicks(rows).map((p) => [p.night_date, p.site_id]),
    [[night, "douglas"], [addDays(night, 1), "douglas"], [night, "wachusett"]]);

  const rec = new Recorder();
  rec.ranking = rows;
  const plan = await buildPlan(rec, { lat: 42.36, lon: -71.09 });
  assert.equal(plan.source, "ranking");
  assert.equal(plan.picks.length, 3);
  assert.ok(plan.group_message.startsWith("📣"));
});
