// The StarCrew agent loop on Gemini (Vertex AI). Same prompt, tools and plan building as
// the Claude client; only the request/response format differs.

import { MAX_ITERATIONS, Recorder, SYSTEM_PROMPT, buildPlan, contextLine, toolSpecs } from "../js/core.js";

const textOf = (content) =>
  (content?.parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();

/**
 * Run one plan. `ai` is a GoogleGenAI client (or a fake in tests). Calls onEvent with the
 * same UI events as the browser client: tool_call, tool_result, plan, text, usage, error, done.
 */
export async function runGeminiPlan({ ai, model, label = model, request, start, onEvent }) {
  const rec = new Recorder();
  const specs = toolSpecs(rec, start);
  const byName = Object.fromEntries(specs.map((t) => [t.name, t]));
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    tools: [{
      functionDeclarations: specs.map((t) => ({
        name: t.name, description: t.description, parametersJsonSchema: t.input_schema,
      })),
    }],
  };
  const contents = [{ role: "user", parts: [{ text: `${contextLine(start)}\n\nRequest: ${request}` }] }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = "";

  for (let turn = 0; turn < MAX_ITERATIONS; turn++) {
    const resp = await ai.models.generateContent({ model, contents, config });
    usage.input_tokens += resp.usageMetadata?.promptTokenCount || 0;
    usage.output_tokens += (resp.usageMetadata?.candidatesTokenCount || 0) + (resp.usageMetadata?.thoughtsTokenCount || 0);

    const candidate = resp.candidates?.[0];
    if (!candidate?.content) {
      const reason = candidate?.finishReason || resp.promptFeedback?.blockReason || "no answer";
      onEvent({ type: "error", message: `Gemini returned no answer (${reason}). Try rephrasing the request.` });
      return;
    }
    contents.push(candidate.content);
    const text = textOf(candidate.content);
    if (text) finalText = text;

    const calls = (candidate.content.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) break;

    const responses = [];
    for (const call of calls) {
      onEvent({ type: "tool_call", name: call.name, input: call.args || {} });
      let result;
      try {
        const tool = byName[call.name];
        result = tool ? await tool.run(call.args || {}) : JSON.stringify({ error: `unknown tool ${call.name}` });
      } catch (err) {
        result = JSON.stringify({ error: err.message });
      }
      responses.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
    }
    rec.drain().forEach(onEvent);
    contents.push({ role: "user", parts: responses });
  }

  const plan = await buildPlan(rec, start);
  rec.drain().forEach(onEvent);
  onEvent({ type: "plan", plan });
  onEvent({ type: "text", text: finalText });
  onEvent({ type: "usage", model: label, hosted: true, ...usage });
  onEvent({ type: "done" });
}
