// StarCrew front end. There is no server: the agent, the tools and the API calls all run
// in this page. The API key lives only in this browser (sessionStorage, or localStorage if
// "Remember" is ticked) and is sent only to api.anthropic.com.

import { DEFAULT_MODEL, MODELS, checkKey, isLocal, localModels, runPlan as runAgent } from "./agent.js";
import { rankNights } from "./planner.js";
import { DEFAULT_START } from "./sites.js";
import { geocode } from "./weather.js";

const KEY_NAME = "starcrew.apiKey";
const MODEL_NAME = "starcrew.model";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  set(k, v, remember) { try { (remember ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  clear(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};

let state = { key: null, model: null, models: [], guest: false, start: null, calls: {}, plan: null };

// ---------- night sky ----------
(function starfield() {
  const canvas = $("stars");
  const ctx = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let stars = [], meteor = null, w, h;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((w * h) / 2600);
    stars = Array.from({ length: n }, () => {
      const r = Math.random() ** 3 * 1.6 + 0.3;
      const tint = Math.random();
      return {
        x: Math.random() * w, y: Math.random() * h * 0.92, r,
        a: 0.35 + Math.random() * 0.65, s: 0.5 + Math.random() * 2, p: Math.random() * 6.28,
        c: tint < 0.12 ? "255,214,170" : tint < 0.25 ? "190,210,255" : "255,255,255",
      };
    });
  }

  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const tw = still ? 1 : 0.75 + 0.25 * Math.sin(t / 1000 * s.s + s.p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 6.283);
      ctx.fillStyle = `rgba(${s.c},${s.a * tw})`;
      ctx.fill();
      if (s.r > 1.4) {
        ctx.fillStyle = `rgba(${s.c},${0.08 * tw})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 4, 0, 6.283); ctx.fill();
      }
    }
    if (!still) {
      if (!meteor && Math.random() < 0.002) {
        meteor = { x: Math.random() * w * 0.8 + w * 0.2, y: Math.random() * h * 0.35, life: 0 };
      }
      if (meteor) {
        const len = 140, k = meteor.life / 45;
        const x = meteor.x - k * 260, y = meteor.y + k * 120;
        const g = ctx.createLinearGradient(x, y, x + len, y - len * 0.46);
        g.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - k)})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = g; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y - len * 0.46); ctx.stroke();
        if (++meteor.life > 45) meteor = null;
      }
      requestAnimationFrame(frame);
    }
  }

  addEventListener("resize", () => { resize(); if (still) frame(0); });
  resize();
  requestAnimationFrame(frame);
})();

// ---------- sign-in ----------
async function init() {
  const res = {
    default: DEFAULT_MODEL,
    models: Object.entries(MODELS).map(([id, name]) => ({ id, name })),
    local: await localModels(),
  };
  state.models = [...res.models, ...res.local];
  $("model").innerHTML = res.models.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  $("model").value = res.models.some((m) => m.id === store.get(MODEL_NAME)) ? store.get(MODEL_NAME) : res.default;
  if (res.local.length) {
    $("local-model").innerHTML = res.local.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    $("local-box").hidden = false;
  }
  const saved = store.get(KEY_NAME);
  if (saved) { state.key = saved; state.model = $("model").value; showApp(); }
}

const modelName = (id) => (state.models.find((m) => m.id === id) || {}).name || id;
const canPlan = () => !!state.key || isLocal(state.model);

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("api-key").value.trim();
  const model = $("model").value;
  const btn = $("signin-btn");
  $("signin-error").hidden = true;
  btn.disabled = true; btn.textContent = "Checking key…";
  try {
    const r = await checkKey(key, model);
    if (!r.ok) throw new Error(r.error || "Key check failed.");
    const remember = $("remember").checked;
    store.set(KEY_NAME, key, remember);
    store.set(MODEL_NAME, model, remember);
    state.key = key; state.model = model; state.guest = false;
    $("api-key").value = "";
    showApp();
  } catch (err) {
    $("signin-error").textContent = err.message;
    $("signin-error").hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Connect key";
  }
});

$("guest-btn").addEventListener("click", () => { state.guest = true; state.key = null; state.model = null; showApp(); runForecast(); });
$("local-btn").addEventListener("click", () => { state.key = null; state.guest = false; state.model = $("local-model").value; showApp(); });
$("to-signin").addEventListener("click", signOut);
$("signout-btn").addEventListener("click", signOut);

function signOut() {
  store.clear(KEY_NAME);
  state.key = null; state.guest = false; state.model = null;
  $("app").hidden = true; $("signin").hidden = false;
}

function showApp() {
  $("signin").hidden = true; $("app").hidden = false;
  $("account-chip").textContent = state.key
    ? `Your key · ${modelName(state.model)} · …${state.key.slice(-4)}`
    : isLocal(state.model) ? `Local · ${modelName(state.model)} · free` : "Guest · forecast only";
  $("signout-btn").textContent = canPlan() ? "Sign out" : "Sign in";
  $("plan-btn").disabled = !canPlan();
  $("plan-btn").textContent = isLocal(state.model) ? "Plan with local model" : "Plan with Claude";
  $("guest-note").hidden = canPlan();
}

document.querySelectorAll(".example").forEach((b) => b.addEventListener("click", () => { $("request").value = b.textContent; }));

// ---------- start point ----------
async function resolveStart() {
  const label = $("start-label").value.trim() || "Cambridge, MA";
  if (state.start && state.start.label === label) return state.start;
  if (/^cambridge/i.test(label)) return (state.start = { ...DEFAULT_START, label });
  const results = await geocode(label.split(",")[0]);
  const hit = results.find((x) => x.country === "United States") || results[0];
  if (!hit) throw new Error(`Couldn't find "${label}".`);
  return (state.start = { label, lat: hit.lat, lon: hit.lon });
}

// ---------- free forecast ----------
$("forecast-btn").addEventListener("click", runForecast);

async function runForecast() {
  const btn = $("forecast-btn");
  btn.disabled = true; btn.textContent = "Loading…";
  try {
    const start = await resolveStart();
    const r = await rankNights(start.lat, start.lon, +$("max-drive").value || 120, 7);
    renderForecast({ ...r, start });
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Forecast only (free)";
  }
}

const pillClass = (v) => (v.startsWith("go") ? "go" : v.startsWith("maybe") ? "maybe" : "nogo");

function renderForecast(r) {
  $("forecast-panel").hidden = false;
  $("forecast-meta").textContent = `— best site per night, ${r.sites_considered} sites within ${$("max-drive").value} min of ${r.start.label}`;
  const rows = r.nights.map((n) => `
    <tr>
      <td>${n.weekday} ${n.date.slice(5)}</td>
      <td>${esc(n.site_name)}</td>
      <td>${n.usable_hours} h</td>
      <td>${n.moon_illumination_pct}%</td>
      <td>${n.cloud_pct ?? "—"}${n.cloud_pct == null ? "" : "%"}</td>
      <td><span class="pill ${n.confidence}">${n.confidence}</span></td>
      <td><span class="pill ${pillClass(n.verdict)}">${esc(n.verdict)}</span></td>
    </tr>`).join("");
  $("forecast-table").innerHTML = `
    <tr><th>Night</th><th>Best site</th><th>Usable dark</th><th>Moon lit</th><th>Cloud</th><th>Confidence</th><th>Verdict</th></tr>${rows}`;
}

function showError(msg) {
  $("error-text").textContent = msg;
  $("error-panel").hidden = false;
}

// ---------- AI planner ----------
$("plan-btn").addEventListener("click", runPlan);

async function runPlan() {
  if (!canPlan()) return signOut();
  const btn = $("plan-btn");
  const btnLabel = btn.textContent;
  btn.disabled = true;
  state.calls = {}; state.plan = null;
  $("results").hidden = true; $("error-panel").hidden = true;
  $("trace").innerHTML = ""; $("live-trace").innerHTML = ""; $("answer").textContent = ""; $("usage").textContent = "";
  $("progress").hidden = false;
  $("progress-text").textContent = `Asking ${modelName(state.model)}…`;

  try {
    const start = await resolveStart();
    await runAgent({ apiKey: state.key, request: $("request").value, model: state.model, start, onEvent: handleEvent });
  } catch (err) {
    handleEvent({ type: "error", message: err.message });
  } finally {
    $("progress").hidden = true;
    btn.disabled = false; btn.textContent = btnLabel;
  }
}

const TOOL_LABEL = {
  geocode: "Looking up the start point",
  list_dark_sites: "Finding dark sites in range",
  forecast_nights: "Ranking nights × sites (weather + astronomy)",
  site_night_detail: "Checking one site in detail",
  submit_plan: "Writing up the plan",
};

function handleEvent(ev) {
  switch (ev.type) {
    case "tool_call": {
      const li = document.createElement("li");
      li.className = "call";
      li.innerHTML = `${esc(TOOL_LABEL[ev.name] || ev.name)} <code>${esc(ev.name)}</code>`;
      $("live-trace").append(li);
      $("progress-text").textContent = `${TOOL_LABEL[ev.name] || ev.name}…`;
      break;
    }
    case "tool_result": {
      state.calls[ev.seq] = ev;
      const pending = [...$("live-trace").querySelectorAll("li.call")].find((li) => li.textContent.includes(ev.name));
      if (pending) { pending.className = "done"; pending.innerHTML += ` <span class="muted">— ${esc(ev.summary)}</span>`; }
      else if (ev.by === "app") {
        const li = document.createElement("li"); li.className = "done";
        li.innerHTML = `StarCrew verified the pick <span class="muted">— ${esc(ev.summary)}</span>`;
        $("live-trace").append(li);
      }
      $("trace").append(traceItem(ev));
      $("trace-count").textContent = `${Object.keys(state.calls).length} tool calls`;
      $("progress-text").textContent = "Thinking about the results…";
      break;
    }
    case "plan":
      state.plan = ev.plan;
      renderPlan(ev.plan);
      break;
    case "text":
      $("answer").textContent = ev.text;
      $("note-box").hidden = !ev.text.trim();
      break;
    case "usage":
      $("usage").textContent = `${ev.local ? "Ran locally (free)" : "Billed to your key"}: ${ev.input_tokens.toLocaleString()} input + ${ev.output_tokens.toLocaleString()} output tokens on ${ev.model}.`;
      break;
    case "error":
      showError(ev.message);
      break;
  }
}

function traceItem(c) {
  const li = document.createElement("li");
  li.className = c.by === "app" ? "app" : "";
  li.innerHTML = `
    <details>
      <summary><span class="seq">#${c.seq}</span> <code>${esc(c.name)}</code>
        <span class="tag ${c.by}">${c.by === "app" ? "StarCrew check" : "called by model"}</span>
        <div class="muted small">${esc(c.summary)}</div></summary>
      <div class="small muted">Input</div><pre class="json">${esc(JSON.stringify(c.input, null, 2))}</pre>
      <div class="small muted">Output</div><pre class="json">${esc(JSON.stringify(c.output, null, 2))}</pre>
    </details>`;
  return li;
}

// ---------- picks ----------
const fmtDate = (iso, weekday) => {
  const d = new Date(iso + "T12:00:00");
  return `${weekday || d.toLocaleDateString("en-US", { weekday: "short" })}, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
};

function renderPlan(plan) {
  $("results").hidden = false;
  $("result-source").textContent = plan.source === "agent"
    ? `Chosen by ${modelName(state.model)}`
    : "Top-ranked by the forecast tool (the model didn't submit picks)";
  $("summary").textContent = plan.summary;
  $("group-message").textContent = plan.group_message;

  $("picks").innerHTML = "";
  plan.picks.forEach((p, i) => {
    const d = p.detail;
    const card = document.createElement("button");
    card.className = `pick glass ${i === 0 ? "top" : ""}`;
    const reasons = (p.why.length ? p.why : p.facts.slice(0, 2)).slice(0, 2);
    card.innerHTML = `
      <span class="badge">${esc(p.label)}</span>
      <div>
        <div class="when">${esc(fmtDate(p.night_date, p.weekday))}</div>
        <div class="where">${esc(p.site_name)} <span>· ${esc(p.town)}</span></div>
      </div>
      <div class="window">✦ ${esc(p.window)}</div>
      ${timelineHTML(d.timeline, true)}
      <div class="chips">
        <span>☁ ${d.cloud_pct ?? "—"}${d.cloud_pct == null ? "" : "%"} cloud</span>
        <span>☾ ${d.moon_illumination_pct}% Moon</span>
        <span class="pill ${esc(d.confidence)}">${esc(d.confidence)} confidence</span>
        <span>🚗 ~${d.drive_minutes_est ?? "?"} min</span>
      </div>
      <ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <span class="more">Details & sources →</span>`;
    card.addEventListener("click", () => openDetail(p));
    $("picks").append(card);
  });
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function timelineHTML(tl, compact = false) {
  if (!tl || !tl.length) return "";
  const cells = tl.map((s) => {
    const cls = !s.dark ? "twilight" : s.usable ? "usable" : "moon";
    const cloud = s.cloud_pct == null ? 0 : s.cloud_pct / 100;
    const title = `${s.t} · ${!s.dark ? "twilight/day" : s.usable ? "usable dark" : "Moon up"}${s.cloud_pct == null ? "" : ` · ${s.cloud_pct}% cloud`}`;
    return `<div class="${cls}" title="${esc(title)}"><span class="cloud" style="opacity:${(cloud * 0.75).toFixed(2)}"></span></div>`;
  }).join("");
  const ticks = compact ? [tl[0], tl[Math.floor(tl.length / 2)], tl[tl.length - 1]] : tl.filter((_, i) => i % 4 === 0);
  return `<div><div class="timeline">${cells}</div>
    <div class="ticks">${ticks.map((s) => `<span>${s.t}</span>`).join("")}</div></div>`;
}

// ---------- detail view ----------
function openDetail(p) {
  const d = p.detail;
  const models = Object.entries(d.per_model || {});
  const sources = p.sources.map((s) => state.calls[s]).filter(Boolean);
  $("detail-body").innerHTML = `
    <div class="d-head">
      <span class="eyebrow">${esc(p.label)}</span>
      <div class="when">${esc(fmtDate(p.night_date, p.weekday))} · ${esc(p.window)}</div>
      <div class="muted">${esc(p.site_name)}, ${esc(p.town)}</div>
    </div>

    <div class="stat-grid">
      ${stat("Usable darkness", `${d.usable_hours} h`)}
      ${stat("Full darkness", `${d.dark_start}–${d.dark_end}`)}
      ${stat("Cloud cover", d.cloud_pct == null ? "—" : `${d.cloud_pct}%`)}
      ${stat("Confidence", `<span class="pill ${esc(d.confidence)}">${esc(d.confidence)}</span>`, true)}
      ${stat("Moon", `${d.moon_illumination_pct}% · ${esc(d.moon_phase)}`, true)}
      ${stat("Sky darkness", `Bortle ${d.bortle}`)}
      ${stat("Drive (est.)", `~${d.drive_minutes_est ?? "?"} min`)}
      ${stat("Score", d.score)}
    </div>

    <div class="d-section">
      <h4>Night timeline (16:00 → 08:00)</h4>
      ${timelineHTML(d.timeline)}
      <div class="legend">
        <span><i style="background:#121A44;box-shadow:inset 0 -3px 0 #F2C14E"></i>Usable dark</span>
        <span><i style="background:#4E5C93"></i>Dark, Moon up</span>
        <span><i style="background:#34407A"></i>Twilight / day</span>
        <span><i style="background:#D9DEEA"></i>Cloud (lighter = cloudier)</span>
      </div>
    </div>

    <div class="d-grid">
      <div class="d-section">
        <h4>Why this pick ${p.why.length ? "· model's reasoning" : ""}</h4>
        ${p.why.length ? `<ul>${p.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
          : `<p class="muted small">The model didn't give reasons for this pick; it was ranked by the forecast tool. See the facts below.</p>`}
        <h4 style="margin-top:16px">Key facts · from tools</h4>
        <ul>${p.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      </div>
      <div class="d-section">
        <h4>Cloud cover by weather model</h4>
        <div class="bars">${models.map(([m, v]) => `
          <div class="bar"><span>${esc(m)}</span><div class="track"><div class="fill" style="width:${v}%"></div></div><span>${v}%</span></div>`).join("")
          || `<p class="muted small">No forecast this far out.</p>`}
        </div>
        <p class="muted small">Mean over the usable hours. Spread between models: ${d.spread ?? "—"} points → ${esc(d.confidence)} confidence.</p>
        <h4 style="margin-top:16px">Site note</h4>
        <p class="small" style="margin:0">${esc(p.note)} Check park hours before you go.</p>
      </div>
    </div>

    <div class="d-section">
      <h4>Sources · tool calls behind this pick</h4>
      <ol class="src-list">${sources.map((c) => `
        <li class="src">
          <span class="seq">#${c.seq}</span><code>${esc(c.name)}</code>
          <span class="tag ${c.by}">${c.by === "app" ? "StarCrew check" : "called by model"}</span>
          <div class="small">${esc(c.summary)}</div>
          <details><summary>Show input and output</summary>
            <pre class="json">${esc(JSON.stringify({ input: c.input, output: c.output }, null, 2))}</pre>
          </details>
        </li>`).join("")}</ol>
      <p class="providers">Data: Open-Meteo forecast API (GFS, ECMWF IFS 0.25°, ICON) · Skyfield with the JPL DE421 ephemeris ·
        StarCrew's curated site list (Bortle values approximate) · drive times estimated from straight-line distance.</p>
    </div>`;
  $("detail").showModal();
  $("detail").scrollTop = 0;
}

function stat(k, v, raw = false) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${raw ? v : esc(v)}</div></div>`;
}

$("detail-close").addEventListener("click", () => $("detail").close());
$("detail").addEventListener("click", (e) => { if (e.target === $("detail")) $("detail").close(); });

$("copy-btn").addEventListener("click", () => {
  navigator.clipboard.writeText($("group-message").textContent).then(() => {
    $("copy-btn").textContent = "Copied!";
    setTimeout(() => ($("copy-btn").textContent = "Copy"), 1500);
  });
});

init();
