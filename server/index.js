// StarCrew API for the hosted Gemini mode. Runs on Google Cloud Run.
//
// The web page (GitHub Pages) calls this server only when a visitor enters the access
// code. Requests are paid from the project's Google Cloud credit, so the server checks
// the code and rate-limits every caller. On Cloud Run it authenticates to Vertex AI as
// its service account, so no API key is stored anywhere. For local development a key can
// be put in a git-ignored .env file instead (see README).

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { GoogleGenAI } from "@google/genai";

import { DEFAULT_START } from "../js/sites.js";
import { runGeminiPlan } from "./gemini.js";

const env = process.env;
const PORT = Number(env.PORT || 8080);
const ACCESS_CODE = env.ACCESS_CODE || "";
const MODEL = env.GEMINI_MODEL || "gemini-3.8-flash";
const MODEL_LABEL = env.GEMINI_MODEL_LABEL || "Gemini 3.8 Flash";
const ALLOWED_ORIGINS = new Set((env.ALLOWED_ORIGINS ||
  "https://sia-xie-july.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",").map((s) => s.trim()));
const PER_IP_PER_HOUR = Number(env.PLANS_PER_IP_PER_HOUR || 8);
const PER_DAY = Number(env.PLANS_PER_DAY || 150);
const MAX_BODY = 8 * 1024;

let ai = null;
const gemini = () => (ai ??= env.GEMINI_API_KEY
  ? new GoogleGenAI({ vertexai: true, apiKey: env.GEMINI_API_KEY })
  : new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GOOGLE_CLOUD_LOCATION || "global" }));

// ---------- limits (in memory; deploy with max-instances=1 so they hold) ----------
const hits = new Map(); // ip -> timestamps of plans in the last hour
let day = new Date().toISOString().slice(0, 10);
let plansToday = 0;

export function takeSlot(ip, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) { day = today; plansToday = 0; }
  if (plansToday >= PER_DAY) return "StarCrew's daily limit is used up. Try again tomorrow, or sign in with your own Claude key.";
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= PER_IP_PER_HOUR) return "You've reached the hourly limit for this access code. Try again later.";
  recent.push(now);
  hits.set(ip, recent);
  plansToday += 1;
  return null;
}

function codeOk(code) {
  if (!ACCESS_CODE || typeof code !== "string") return false;
  const a = Buffer.from(code.trim()), b = Buffer.from(ACCESS_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- http ----------
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "3600");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cleanStart(s) {
  const ok = s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180;
  return ok ? { label: String(s.label || "Start").slice(0, 80), lat: s.lat, lon: s.lon } : DEFAULT_START;
}

const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

export const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url, "http://x");

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, model: MODEL_LABEL });
    }

    if (req.method === "POST" && url.pathname === "/api/check") {
      const { code } = await readJson(req);
      return send(res, 200, codeOk(code) ? { ok: true, model: MODEL_LABEL } : { ok: false, error: "That access code isn't valid." });
    }

    if (req.method === "POST" && url.pathname === "/api/plan") {
      const body = await readJson(req);
      if (!codeOk(body.code)) return send(res, 401, { error: "That access code isn't valid." });
      const request = String(body.request || "").trim();
      if (request.length < 3 || request.length > 1500) return send(res, 400, { error: "Please write a request between 3 and 1500 characters." });
      const limited = takeSlot(clientIp(req));
      if (limited) return send(res, 429, { error: limited });

      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const onEvent = (ev) => res.write(JSON.stringify(ev) + "\n");
      try {
        await runGeminiPlan({ ai: gemini(), model: MODEL, label: MODEL_LABEL, request, start: cleanStart(body.start), onEvent });
      } catch (err) {
        const status = err.status ? ` (${err.status})` : "";
        console.error("plan failed", status, err.message);
        onEvent({ type: "error", message: err.status === 429 ? "Gemini is busy right now. Try again in a minute." : `Planner failed${status}.` });
      }
      return res.end();
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: err.message });
    else res.end();
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!ACCESS_CODE) console.warn("ACCESS_CODE is not set: every plan request will be refused.");
  server.listen(PORT, () => console.log(`StarCrew API on :${PORT} (model ${MODEL})`));
}
