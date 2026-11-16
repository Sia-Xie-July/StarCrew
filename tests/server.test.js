// Gemini agent loop with a scripted fake Gemini client, and the API server's guards.
// No key and no credit needed; the weather calls are real, so this needs network access.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ACCESS_CODE = "test-code";
process.env.PLANS_PER_IP_PER_HOUR = "2";
const { runGeminiPlan } = await import("../server/gemini.js");
const { server, takeSlot } = await import("../server/index.js");
const { addDays, tonight } = await import("../js/time.js");

const night = addDays(tonight(), 1);
const fnCall = (name, args) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: name, name, args } }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });

test("Gemini loop runs tools, sends results back and builds verified picks", async () => {
  const script = [
    fnCall("forecast_nights", { max_drive_minutes: 120, nights: 3 }),
    fnCall("submit_plan", { summary: "Go to Douglas.", group_message: "📣 Stargazing!", picks: [
      { night_date: night, site_id: "douglas", window_start: "22:40", window_end: "05:10", why: ["models agree"] }] }),
    { candidates: [{ content: { role: "model", parts: [{ text: "Clear skies!" }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } },
  ];
  const requests = [];
  const ai = { models: { generateContent: async (req) => { requests.push(structuredClone(req)); return script[requests.length - 1]; } } };
  const events = [];
  await runGeminiPlan({ ai, model: "gemini-test", request: "best night?", start: { label: "Cambridge", lat: 42.36, lon: -71.09 }, onEvent: (e) => events.push(e) });

  assert.equal(events.at(-1).type, "done", JSON.stringify(events.filter((e) => e.type === "error")));
  assert.deepEqual(events.filter((e) => e.type === "tool_call").map((e) => e.name), ["forecast_nights", "submit_plan"]);
  const { plan } = events.find((e) => e.type === "plan");
  assert.equal(plan.source, "agent");
  assert.equal(plan.picks[0].site_name, "Douglas State Forest");
  assert.equal(events.find((e) => e.type === "text").text, "Clear skies!");
  assert.equal(events.find((e) => e.type === "usage").input_tokens, 250);

  const decl = requests[0].config.tools[0].functionDeclarations.map((d) => d.name);
  assert.deepEqual(decl, ["geocode", "list_dark_sites", "forecast_nights", "site_night_detail", "submit_plan"]);
  const reply = requests[1].contents.at(-1);
  assert.equal(reply.role, "user");
  assert.equal(reply.parts[0].functionResponse.name, "forecast_nights");
  assert.match(reply.parts[0].functionResponse.response.result, /best_per_night/);
});

test("per-IP rate limit", () => {
  const now = Date.now();
  assert.equal(takeSlot("1.2.3.4", now), null);
  assert.equal(takeSlot("1.2.3.4", now + 1), null);
  assert.match(takeSlot("1.2.3.4", now + 2), /hourly limit/);
  assert.equal(takeSlot("5.6.7.8", now + 3), null);
  assert.equal(takeSlot("1.2.3.4", now + 3600e3 + 5), null); // an hour later it frees up
});

test("server checks the access code and CORS origin", async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body, origin) => fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });

    assert.deepEqual(await (await post("/api/check", { code: "test-code" })).json(), { ok: true, model: "Gemini 3.8 Flash" });
    assert.equal((await (await post("/api/check", { code: "nope" })).json()).ok, false);
    assert.equal((await post("/api/plan", { code: "nope", request: "best night?" })).status, 401);
    assert.equal((await post("/api/plan", { code: "test-code", request: "" })).status, 400);

    const ok = await post("/api/check", { code: "x" }, "https://sia-xie-july.github.io");
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://sia-xie-july.github.io");
    const bad = await post("/api/check", { code: "x" }, "https://evil.example");
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});
