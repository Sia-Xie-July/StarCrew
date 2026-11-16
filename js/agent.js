// The StarCrew planner agent: Claude reasons, deterministic tools supply the facts.
//
// Everything runs in the visitor's browser. The visitor's own Anthropic API key is sent
// straight from the browser to api.anthropic.com; there is no StarCrew server.

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

import { MAX_ITERATIONS, Recorder, SYSTEM_PROMPT, buildPlan, contextLine, toolSpecs } from "./core.js";
import { DEFAULT_START } from "./sites.js";

export { Recorder, buildPlan, fallbackPicks } from "./core.js";

export const MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
};
export const DEFAULT_MODEL = "claude-opus-5-5";
// Models that support server-side refusal fallbacks
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// Local development: Ollama serves an Anthropic-compatible Messages API, so the same
// SDK and agent loop run against a local model at no cost. Only offered when the page
// itself is served from localhost. Local model ids are prefixed "ollama/".
export const OLLAMA_URL = "http://localhost:11434";
export const LOCAL_PREFIX = "ollama/";
export const isLocal = (model) => !!model && model.startsWith(LOCAL_PREFIX);

export async function localModels() {
  const host = globalThis.location?.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return [];
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const { models = [] } = await resp.json();
    return models
      .filter((m) => (m.capabilities || ["tools"]).includes("tools"))
      .map((m) => ({ id: LOCAL_PREFIX + m.name, name: `${m.name} (local, Ollama)` }));
  } catch {
    return [];
  }
}

// Ollama's CORS rules only allow these request headers. The Anthropic-specific ones
// (anthropic-version, anthropic-beta, x-api-key, ...) mean nothing to Ollama, so the
// local client drops them instead of failing the browser's preflight check.
const OLLAMA_CORS_HEADERS = new Set(["authorization", "content-type", "user-agent", "accept",
  "x-requested-with", "x-stainless-arch", "x-stainless-async", "x-stainless-helper-method",
  "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-retry-count",
  "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout"]);

function ollamaFetch(baseFetch) {
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    for (const name of [...headers.keys()]) if (!OLLAMA_CORS_HEADERS.has(name)) headers.delete(name);
    return baseFetch(url, { ...init, headers });
  };
}

function makeClient(apiKey, model, extra = {}) {
  const opts = { dangerouslyAllowBrowser: true, maxRetries: 2, ...extra };
  if (isLocal(model)) {
    const fetch = ollamaFetch(extra.fetch || globalThis.fetch.bind(globalThis));
    return [new Anthropic({ ...opts, apiKey: "ollama", baseURL: OLLAMA_URL, fetch }), model.slice(LOCAL_PREFIX.length)];
  }
  return [new Anthropic({ ...opts, apiKey }), model];
}

function errorMessage(err, model) {
  if (err instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it and sign in again.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (err instanceof Anthropic.NotFoundError) return `Model ${model} isn't available for this key.`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limit or credit limit reached on your key. Try again later.";
  if (err instanceof Anthropic.APIConnectionError) {
    return `Couldn't reach ${isLocal(model) ? "the local Ollama server" : "the Claude API"}. Check that it's running.`;
  }
  if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}): ${err.message}`;
  return `Planner failed: ${err.message}`;
}

/**
 * Run the agent. Calls onEvent with UI events:
 * tool_call, tool_result, plan, text, usage, error, done.
 * `clientOptions` is for tests (e.g. a fake fetch).
 */
export async function runPlan({ apiKey, request, model = DEFAULT_MODEL, start = DEFAULT_START, onEvent, clientOptions = {} }) {
  if (!MODELS[model] && !isLocal(model)) model = DEFAULT_MODEL;
  const rec = new Recorder();
  const emitPending = () => rec.drain().forEach(onEvent);
  const [client, wireModel] = makeClient(apiKey, model, clientOptions);
  const label = MODELS[model] || `${model.slice(LOCAL_PREFIX.length)} (local)`;

  const context = contextLine(start);

  const extra = isLocal(model)
    // Small local models answer faster and stay on task with thinking off.
    ? { thinking: { type: "disabled" } }
    : { output_config: { effort: "medium" },
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}) };

  const runner = client.beta.messages.toolRunner({
    model: wireModel,
    max_tokens: 16000,
    max_iterations: MAX_ITERATIONS,
    system: SYSTEM_PROMPT,
    tools: toolSpecs(rec, start).map((t) => betaTool({ name: t.name, description: t.description, inputSchema: t.input_schema, run: t.run })),
    messages: [{ role: "user", content: `${context}\n\nRequest: ${request}` }],
    ...extra,
  });

  const usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = "";
  try {
    for await (const message of runner) {
      emitPending();
      usage.input_tokens += message.usage?.input_tokens || 0;
      usage.output_tokens += message.usage?.output_tokens || 0;
      for (const block of message.content) {
        if (block.type === "tool_use") onEvent({ type: "tool_call", name: block.name, input: block.input });
        else if (block.type === "text" && block.text.trim()) finalText = block.text;
      }
      if (message.stop_reason === "refusal") {
        onEvent({ type: "error", message: "Claude declined this request. Try rephrasing it." });
        return;
      }
    }
    emitPending();
  } catch (err) {
    onEvent({ type: "error", message: errorMessage(err, model) });
    return;
  }

  const plan = await buildPlan(rec, start);
  emitPending();
  onEvent({ type: "plan", plan });
  onEvent({ type: "text", text: finalText });
  onEvent({ type: "usage", model: label, local: isLocal(model), ...usage });
  onEvent({ type: "done" });
}

/** Validate a key without spending tokens (Models API lookups are free). */
export async function checkKey(apiKey, model = DEFAULT_MODEL, clientOptions = {}) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 15000, ...clientOptions });
  try {
    const info = await client.models.retrieve(MODELS[model] ? model : DEFAULT_MODEL);
    return { ok: true, model: info.id, display_name: info.display_name };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "That API key was rejected." };
    if (err instanceof Anthropic.NotFoundError) return { ok: false, error: "Key works, but this model isn't available for it." };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: "Couldn't reach the Claude API." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Claude API error (${err.status}).` };
    return { ok: false, error: err.message };
  }
}
