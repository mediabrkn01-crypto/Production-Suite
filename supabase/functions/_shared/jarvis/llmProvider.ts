// LLM providers behind one interface, so Jarvis can switch Claude ↔ Sarvam (LLM_PROVIDER)
// without touching the orchestrator. Each provider owns its own tool-use loop and message
// format; the orchestrator supplies tools + an executor and receives text AS IT STREAMS.
//
// Streaming (2026-10-16): both providers stream tokens. `onText` fires with every visible text
// delta so the voice engine can start speaking at the first complete sentence instead of
// waiting for the whole answer. `signal` aborts the in-flight model call (barge-in).
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { config } from "./config.ts";
import type { Turn } from "./jarvisAudit.ts";
import type { ToolDefinition, ToolResult } from "./erpTools.ts";

export interface ToolCall { id: string; name: string; args: unknown }

export interface LlmRequest {
  system: string;
  history: Turn[];
  userText: string;
  tools: ToolDefinition[];
  maxToolCalls: number;
  /** Runs a batch of tool calls (in parallel) and returns results in the same order. */
  executeTools: (calls: ToolCall[]) => Promise<ToolResult[]>;
  /** Visible answer text, as it streams (never tool JSON, never hidden reasoning). */
  onText?: (delta: string) => void;
  /** First token / first tool call of the turn — for latency telemetry. */
  onFirstToken?: () => void;
  /** Cancels the model call (barge-in / client gone). */
  signal?: AbortSignal;
}
export interface LlmResponse { text: string; toolCalls: number }

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  answer(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(public code: "LLM_UNAVAILABLE" | "LLM_RATE_LIMIT" | "LLM_REFUSAL" | "LLM_CONFIG" | "LLM_BAD_RESPONSE" | "LLM_ABORTED", message: string) { super(message); }
}

const TOOL_BUDGET_NOTE = "Tool-call limit reached for this question. Answer now from the results you already have, and say plainly if something could not be checked.";
const aborted = (s?: AbortSignal) => !!s && s.aborted;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Anthropic (Claude) — streaming manual tool-use loop on the Messages API
// ─────────────────────────────────────────────────────────────────────────────────────────
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model = config.claudeModel;
  private client: Anthropic;

  constructor() {
    if (!config.anthropicApiKey) throw new LlmError("LLM_CONFIG", "ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1, timeout: 25_000 });
  }

  async answer(req: LlmRequest): Promise<LlmResponse> {
    const tools: Anthropic.Tool[] = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      // Cache the stable prefix (tools + system) across turns.
      ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const messages: Anthropic.MessageParam[] = [
      ...req.history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
      { role: "user", content: req.userText },
    ];
    // Claude 5.x: server-side refusal fallback (routes a declined request to Anthropic's
    // recommended model instead of returning a refusal). Effort low = fastest voice answers.
    const modern = /^claude-(opus|sonnet)-5/.test(this.model);
    let used = 0, all = "", first = false;
    for (let round = 0; round < req.maxToolCalls + 2; round++) {
      if (aborted(req.signal)) throw new LlmError("LLM_ABORTED", "aborted");
      const budgetLeft = req.maxToolCalls - used;
      // deno-lint-ignore no-explicit-any
      const params: any = {
        model: this.model,
        max_tokens: 4096,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools,
        tool_choice: budgetLeft > 0 ? { type: "auto" } : { type: "none" },
        messages,
        ...(config.llmEffort ? { output_config: { effort: config.llmEffort } } : {}),
        ...(modern ? { fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] } : {}),
      };
      let res: Anthropic.Message;
      try {
        // deno-lint-ignore no-explicit-any
        const stream: any = modern ? (this.client.beta.messages as any).stream(params, { signal: req.signal }) : this.client.messages.stream(params, { signal: req.signal });
        let roundText = "";
        stream.on("text", (delta: string) => {
          if (!first) { first = true; req.onFirstToken?.(); }
          roundText += delta;
          req.onText?.(delta);
        });
        stream.on("contentBlock", (b: { type: string }) => { if (!first && b.type === "tool_use") { first = true; req.onFirstToken?.(); } });
        res = await stream.finalMessage();
        if (roundText) all += (all ? " " : "") + roundText;
      } catch (e) {
        if (aborted(req.signal) || (e instanceof Error && /abort/i.test(e.name + e.message))) throw new LlmError("LLM_ABORTED", "aborted");
        if (e instanceof Anthropic.RateLimitError) throw new LlmError("LLM_RATE_LIMIT", "rate limited");
        if (e instanceof Anthropic.APIError) throw new LlmError("LLM_UNAVAILABLE", `${e.status ?? ""} ${e.message}`);
        throw new LlmError("LLM_UNAVAILABLE", e instanceof Error ? e.message : String(e));
      }
      if (res.stop_reason === "refusal") throw new LlmError("LLM_REFUSAL", "model declined");
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) {
        const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
        if (!text && !all) throw new LlmError("LLM_BAD_RESPONSE", "empty answer (" + res.stop_reason + ")");
        return { text: (all || text).trim(), toolCalls: used };
      }
      messages.push({ role: "assistant", content: res.content });
      const allowed = uses.slice(0, Math.max(0, budgetLeft));
      const results = allowed.length ? await req.executeTools(allowed.map((u) => ({ id: u.id, name: u.name, args: u.input }))) : [];
      used += allowed.length;
      // Every tool_use must get a tool_result, all in ONE user message.
      const blocks: Anthropic.ToolResultBlockParam[] = uses.map((u, i) => i < allowed.length
        ? { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(results[i].ok ? results[i].data : { error: results[i].error }), is_error: !results[i].ok }
        : { type: "tool_result", tool_use_id: u.id, content: TOOL_BUDGET_NOTE, is_error: true });
      messages.push({ role: "user", content: blocks });
      // Text spoken before the tool call ("Let me check…") is already on its way to TTS;
      // the final answer continues the same reply.
    }
    throw new LlmError("LLM_BAD_RESPONSE", "tool loop did not finish");
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Sarvam (sarvam-105b) — OpenAI-style chat completions with function calling, STREAMED (SSE)
// ─────────────────────────────────────────────────────────────────────────────────────────
interface SarvamMsg { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: SarvamToolCall[]; tool_call_id?: string }
interface SarvamToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

/** Removes <think>…</think> spans from a token stream (they can straddle deltas). */
class ThinkFilter {
  private inside = false; private carry = "";
  push(s: string): string {
    let buf = this.carry + s, out = ""; this.carry = "";
    for (;;) {
      if (this.inside) {
        const e = buf.indexOf("</think>");
        if (e < 0) { this.carry = buf.slice(-8); return out; }
        buf = buf.slice(e + 8); this.inside = false;
      } else {
        const b = buf.indexOf("<think>");
        if (b < 0) {
          // hold back a possible partial "<think" at the end
          const k = buf.lastIndexOf("<");
          if (k >= 0 && buf.length - k < 7 && "<think>".startsWith(buf.slice(k))) { out += buf.slice(0, k); this.carry = buf.slice(k); }
          else out += buf;
          return out;
        }
        out += buf.slice(0, b); buf = buf.slice(b + 7); this.inside = true;
      }
    }
  }
}

export class SarvamLlmProvider implements LlmProvider {
  readonly name = "sarvam";
  readonly model = config.sarvamLlmModel;
  private canStream = true;

  constructor() {
    if (!config.sarvamApiKey) throw new LlmError("LLM_CONFIG", "SARVAM_API_KEY is not set");
  }

  private body(messages: SarvamMsg[], tools: ToolDefinition[], allowTools: boolean, stream: boolean) {
    return JSON.stringify({
      // Hidden reasoning off (voice latency; it otherwise ate the whole budget → empty answers).
      model: this.model, messages, temperature: 0.2, max_tokens: 2048, reasoning_effort: null, stream,
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: allowTools ? "auto" : "none" } : {}),
    });
  }

  /** One streamed round. Returns the assistant text + any tool calls. */
  private async round(req: LlmRequest, messages: SarvamMsg[], allowTools: boolean, mark: () => void): Promise<{ text: string; calls: SarvamToolCall[] }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    const onAbort = () => ctl.abort();
    req.signal?.addEventListener("abort", onAbort);
    try {
      const call = (stream: boolean) => fetch(`${config.sarvamHttpBase}/v1/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", "api-subscription-key": config.sarvamApiKey },
        body: this.body(messages, req.tools, allowTools, stream),
      });
      let r = await call(this.canStream);
      // Provider refused streaming for this request (e.g. tools + stream unsupported) → same
      // request without streaming, and stop asking for streams on this instance.
      if (this.canStream && r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 401 && r.status !== 403) {
        this.canStream = false; try { await r.body?.cancel(); } catch { /* ignore */ }
        r = await call(false);
      }
      if (r.status === 429) throw new LlmError("LLM_RATE_LIMIT", "rate limited");
      if (!r.ok || !r.body) throw new LlmError("LLM_UNAVAILABLE", `sarvam ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      // Provider answered without streaming (e.g. tools not streamable) → treat as one block.
      if (!ct.includes("event-stream")) {
        const j = await r.json();
        const msg = j?.choices?.[0]?.message;
        if (!msg) throw new LlmError("LLM_BAD_RESPONSE", "no choices");
        const text = new ThinkFilter().push(String(msg.content || "")).trim();
        if (text) { mark(); req.onText?.(text); }
        if ((msg.tool_calls || []).length) mark();
        return { text, calls: msg.tool_calls || [] };
      }
      const reader = r.body.getReader(), dec = new TextDecoder(), think = new ThinkFilter();
      let buf = "", text = "";
      const calls: SarvamToolCall[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          const d = j?.choices?.[0]?.delta || {};
          if (d.content) {
            const vis = think.push(String(d.content));
            if (vis) { mark(); text += vis; req.onText?.(vis); }
          }
          for (const tc of d.tool_calls || []) {
            mark();
            const k = tc.index ?? 0;
            calls[k] = calls[k] || { id: tc.id || `call_${k}`, type: "function", function: { name: "", arguments: "" } };
            if (tc.id) calls[k].id = tc.id;
            if (tc.function?.name) calls[k].function.name += tc.function.name;
            if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments;
          }
        }
      }
      return { text: text.trim(), calls: calls.filter(Boolean) };
    } catch (e) {
      if (aborted(req.signal)) throw new LlmError("LLM_ABORTED", "aborted");
      if (e instanceof LlmError) throw e;
      throw new LlmError("LLM_UNAVAILABLE", e instanceof Error ? e.message : String(e));
    } finally { clearTimeout(timer); req.signal?.removeEventListener("abort", onAbort); }
  }

  async answer(req: LlmRequest): Promise<LlmResponse> {
    const messages: SarvamMsg[] = [
      { role: "system", content: req.system },
      ...req.history.map((t) => ({ role: t.role, content: t.content }) as SarvamMsg),
      { role: "user", content: req.userText },
    ];
    let used = 0, first = false, all = "";
    const mark = () => { if (!first) { first = true; req.onFirstToken?.(); } };
    for (let round = 0; round < req.maxToolCalls + 2; round++) {
      if (aborted(req.signal)) throw new LlmError("LLM_ABORTED", "aborted");
      const budgetLeft = req.maxToolCalls - used;
      const { text, calls } = await this.round(req, messages, budgetLeft > 0, mark);
      if (text) all += (all ? " " : "") + text;
      if (!calls.length) {
        if (!all) throw new LlmError("LLM_BAD_RESPONSE", "empty answer");
        return { text: all, toolCalls: used };
      }
      messages.push({ role: "assistant", content: text || null, tool_calls: calls });
      const allowed = calls.slice(0, Math.max(0, budgetLeft));
      const parsed = allowed.map((c) => { let args: unknown = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch { args = { __invalid_json: true }; } return { id: c.id, name: c.function.name, args }; });
      const results = parsed.length ? await req.executeTools(parsed) : [];
      used += allowed.length;
      calls.forEach((c, i) => messages.push({
        role: "tool", tool_call_id: c.id,
        content: i < allowed.length ? JSON.stringify(results[i].ok ? results[i].data : { error: results[i].error }) : TOOL_BUDGET_NOTE,
      }));
    }
    throw new LlmError("LLM_BAD_RESPONSE", "tool loop did not finish");
  }
}

export function createLlmProvider(): LlmProvider {
  return config.llmProvider === "sarvam" ? new SarvamLlmProvider() : new AnthropicProvider();
}
