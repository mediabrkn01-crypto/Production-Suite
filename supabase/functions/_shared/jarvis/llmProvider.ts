// LLM providers behind one interface, so Jarvis can switch Claude ↔ Sarvam (LLM_PROVIDER)
// without touching the orchestrator. Each provider owns its own tool-use loop and message
// format; the orchestrator only supplies tools + an executor and receives the final text.
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
}
export interface LlmResponse { text: string; toolCalls: number }

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  answer(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(public code: "LLM_UNAVAILABLE" | "LLM_RATE_LIMIT" | "LLM_REFUSAL" | "LLM_CONFIG" | "LLM_BAD_RESPONSE", message: string) { super(message); }
}

const TOOL_BUDGET_NOTE = "Tool-call limit reached for this question. Answer now from the results you already have, and say plainly if something could not be checked.";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Anthropic (Claude) — manual tool-use loop on the Messages API
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
    let used = 0;
    for (let round = 0; round < req.maxToolCalls + 2; round++) {
      const budgetLeft = req.maxToolCalls - used;
      let res: Anthropic.Message;
      try {
        res = await this.client.messages.create({
          model: this.model,
          max_tokens: 2048,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          tools,
          tool_choice: budgetLeft > 0 ? { type: "auto" } : { type: "none" },
          messages,
        });
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) throw new LlmError("LLM_RATE_LIMIT", "rate limited");
        if (e instanceof Anthropic.APIError) throw new LlmError("LLM_UNAVAILABLE", `${e.status ?? ""} ${e.message}`);
        throw new LlmError("LLM_UNAVAILABLE", e instanceof Error ? e.message : String(e));
      }
      if (res.stop_reason === "refusal") throw new LlmError("LLM_REFUSAL", "model declined");
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
      if (res.stop_reason !== "tool_use") {
        if (!text) throw new LlmError("LLM_BAD_RESPONSE", "empty answer (" + res.stop_reason + ")");
        return { text, toolCalls: used };
      }

      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      messages.push({ role: "assistant", content: res.content });
      const allowed = uses.slice(0, Math.max(0, budgetLeft));
      const results = allowed.length ? await req.executeTools(allowed.map((u) => ({ id: u.id, name: u.name, args: u.input }))) : [];
      used += allowed.length;
      // Every tool_use must get a tool_result, all in ONE user message.
      const blocks: Anthropic.ToolResultBlockParam[] = uses.map((u, i) => i < allowed.length
        ? { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(results[i].ok ? results[i].data : { error: results[i].error }), is_error: !results[i].ok }
        : { type: "tool_result", tool_use_id: u.id, content: TOOL_BUDGET_NOTE, is_error: true });
      messages.push({ role: "user", content: blocks });
    }
    throw new LlmError("LLM_BAD_RESPONSE", "tool loop did not finish");
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Sarvam (sarvam-105b) — OpenAI-style chat completions with function calling (REST)
// ─────────────────────────────────────────────────────────────────────────────────────────
interface SarvamMsg { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: SarvamToolCall[]; tool_call_id?: string }
interface SarvamToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export class SarvamLlmProvider implements LlmProvider {
  readonly name = "sarvam";
  readonly model = config.sarvamLlmModel;

  constructor() {
    if (!config.sarvamApiKey) throw new LlmError("LLM_CONFIG", "SARVAM_API_KEY is not set");
  }

  private async call(messages: SarvamMsg[], tools: ToolDefinition[], allowTools: boolean) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    try {
      const r = await fetch(`${config.sarvamHttpBase}/v1/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", "api-subscription-key": config.sarvamApiKey },
        body: JSON.stringify({
          // Hidden reasoning off (voice latency; it otherwise ate the whole budget → empty answers).
          model: this.model, messages, temperature: 0.2, max_tokens: 2048, reasoning_effort: null,
          ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: allowTools ? "auto" : "none" } : {}),
        }),
      });
      if (r.status === 429) throw new LlmError("LLM_RATE_LIMIT", "rate limited");
      if (!r.ok) throw new LlmError("LLM_UNAVAILABLE", `sarvam ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError("LLM_UNAVAILABLE", e instanceof Error ? e.message : String(e));
    } finally { clearTimeout(timer); }
  }

  async answer(req: LlmRequest): Promise<LlmResponse> {
    const messages: SarvamMsg[] = [
      { role: "system", content: req.system },
      ...req.history.map((t) => ({ role: t.role, content: t.content }) as SarvamMsg),
      { role: "user", content: req.userText },
    ];
    let used = 0;
    for (let round = 0; round < req.maxToolCalls + 2; round++) {
      const budgetLeft = req.maxToolCalls - used;
      const res = await this.call(messages, req.tools, budgetLeft > 0);
      const msg = res?.choices?.[0]?.message;
      if (!msg) throw new LlmError("LLM_BAD_RESPONSE", "no choices");
      const calls: SarvamToolCall[] = msg.tool_calls || [];
      // Some reasoning models wrap thoughts in <think>…</think>; never speak those.
      const text = String(msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!calls.length) {
        if (!text) throw new LlmError("LLM_BAD_RESPONSE", "empty answer (" + (res?.choices?.[0]?.finish_reason || "?") + ")");
        return { text, toolCalls: used };
      }
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
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
