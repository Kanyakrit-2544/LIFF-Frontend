import type { ZodType } from "zod";
import { env } from "../../env";

export interface LlmProvider {
  name: string;
  complete<T>(input: { system: string; user: string; schema: ZodType<T>; maxTokens?: number }): Promise<T>;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "object" && part && "text" in part ? String(part.text) : "").join("");
  }
  return "";
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export function createLlmProvider(): LlmProvider | null {
  const config = env("llm");
  if (!config.LLM_BASE_URL || !config.LLM_MODEL) return null;
  const baseUrl = config.LLM_BASE_URL.replace(/\/$/, "");

  return {
    name: config.LLM_MODEL,
    async complete<T>(input: { system: string; user: string; schema: ZodType<T>; maxTokens?: number }): Promise<T> {
      const { system, user, schema, maxTokens = 1_000 } = input;
      let lastError: unknown;
      for (let attempt = 0; attempt <= config.LLM_MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);
        try {
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(config.LLM_API_KEY ? { authorization: `Bearer ${config.LLM_API_KEY}` } : {}),
            },
            body: JSON.stringify({
              model: config.LLM_MODEL,
              messages: [{ role: "system", content: system }, { role: "user", content: user }],
              temperature: 0,
              max_tokens: maxTokens,
            }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
          const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
          return schema.parse(parseJson(contentText(body.choices?.[0]?.message?.content)));
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("LLM response invalid");
    },
  };
}
