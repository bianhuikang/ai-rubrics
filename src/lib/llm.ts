import { z } from "zod";
import type { PageEvidence, Rubric, Settings } from "./types";
import { trimForPrompt } from "./requirement-parser";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const rubricSchema = z.object({
  rubrics: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        evidenceHints: z.array(z.string()).default([]),
      }),
    )
    .min(5)
    .max(12),
});

const scoreSchema = z.object({
  scores: z.array(z.number().int().min(0).max(1)),
  reasons: z.array(z.string()),
});

export async function generateRubrics(
  settings: Settings,
  prompt: string,
  candidates: Array<{
    url: string;
    summary: unknown;
  }> = [],
): Promise<Rubric[]> {
  const raw = await callJsonModel(settings, [
    { role: "system", content: settings.rubricPrompt },
    {
      role: "user",
      content: JSON.stringify(
        {
          prompt,
          candidates,
          instruction:
            "Generate 5-12 concise client-acceptance rubrics. Each rubric description must be exactly one sentence in the style of a spreadsheet checklist item, without 'score 1/0', boundary explanations, or long prose. Preserve explicit assets, text, links, libraries, APIs, interactions, animation behavior, controls, and responsive requirements from the prompt.",
        },
        null,
        2,
      ),
    },
  ]);

  const parsed = rubricSchema.parse(parseModelJson(raw));
  return parsed.rubrics.map((rubric, index) => ({
    id: rubric.id || `R${index + 1}`,
    name: rubric.name,
    description: normalizeRubricDescription(rubric.description),
    evidenceHints: rubric.evidenceHints,
  }));
}

function normalizeRubricDescription(value: string) {
  const cleaned = value
    .replace(/给\s*1\s*分[:：]/g, "")
    .replace(/给\s*0\s*分[:：].*$/g, "")
    .replace(/0\/1\s*判定标准[:：]?/g, "")
    .replace(/满足边界[:：]?|不满足边界[:：]?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = cleaned.match(/^.*?[。.!！?？](?=\s|$)/)?.[0] ?? cleaned;
  return firstSentence.replace(/[；;，,\s]+$/g, "").trim();
}

export async function scorePage(input: {
  settings: Settings;
  prompt: string;
  rubrics: Rubric[];
  evidence: PageEvidence;
}) {
  const evidenceForModel = {
    ...input.evidence,
    htmlSample: trimForPrompt(input.evidence.htmlSample, 16000),
    visibleText: trimForPrompt(input.evidence.visibleText, 12000),
  };

  const raw = await callJsonModel(input.settings, [
    { role: "system", content: input.settings.scoringPrompt },
    {
      role: "user",
      content: JSON.stringify(
        {
          prompt: input.prompt,
          rubrics: input.rubrics,
          evidence: evidenceForModel,
        },
        null,
        2,
      ),
    },
  ]);

  const parsed = scoreSchema.parse(parseModelJson(raw));
  if (parsed.scores.length !== input.rubrics.length) {
    throw new Error(`Model returned ${parsed.scores.length} scores for ${input.rubrics.length} rubrics`);
  }
  return {
    scores: parsed.scores,
    reasons: input.rubrics.map((_, index) => parsed.reasons[index] || "No reason returned."),
    rawResponse: raw,
  };
}

export async function testModelConnection(settings: Settings) {
  const endpoint = settings.endpointUrl.trim();
  if (!endpoint) throw new Error("Endpoint URL is required in settings.");
  if (!settings.model.trim()) throw new Error("Model is required in settings.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const body =
    settings.apiFormat === "anthropic-messages"
      ? {
          model: settings.model,
          max_tokens: 8,
          temperature: 0,
          messages: [{ role: "user", content: "give me a number from 0 to 10" }],
          ...parseExtraRequestParams(settings.extraRequestParams),
        }
      : {
          model: settings.model,
          messages: [{ role: "user", content: "give me a number from 0 to 10" }],
          temperature: 0,
          max_tokens: 8,
          stream: false,
          ...parseExtraRequestParams(settings.extraRequestParams),
        };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (settings.apiKey.trim()) {
    if (settings.apiFormat === "anthropic-messages") {
      headers["x-api-key"] = settings.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }
  }

  const startedAt = Date.now();
  logLlmRequest(`${settings.apiFormat}:test`, endpoint, body);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Connection test timed out after 60s: ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  logLlmResponse(`${settings.apiFormat}:test`, endpoint, response.status, text, Date.now() - startedAt);
  if (!response.ok) {
    throw new Error(`Connection test failed: HTTP ${response.status} ${endpoint} ${text.slice(0, 500)}`);
  }

  return {
    ok: true,
    response: `HTTP ${response.status} ${response.statusText} ${text.slice(0, 500)}`,
  };
}

async function callJsonModel(settings: Settings, messages: ChatMessage[]) {
  if (!settings.apiKey.trim()) {
    throw new Error("API key is required in settings.");
  }
  if (!settings.model.trim()) {
    throw new Error("Model is required in settings.");
  }
  if (!settings.endpointUrl.trim()) {
    throw new Error("Endpoint URL is required in settings.");
  }
  return settings.apiFormat === "anthropic-messages" ? callClaude(settings, messages) : callOpenAICompatible(settings, messages);
}

async function callOpenAICompatible(settings: Settings, messages: ChatMessage[]) {
  const endpoint = settings.endpointUrl.trim();
  const requestBody = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    ...parseExtraRequestParams(settings.extraRequestParams),
  };
  const startedAt = Date.now();
  logLlmRequest("openai-chat-completions", endpoint, requestBody);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const responseText = await response.text();
  logLlmResponse("openai-chat-completions", endpoint, response.status, responseText, Date.now() - startedAt);

  if (!response.ok) {
    throw new Error(`OpenAI Chat Completions request failed: ${response.status} ${endpoint} ${responseText}`);
  }

  const data = JSON.parse(responseText) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI-compatible API returned empty content.");
  return content;
}

async function callClaude(settings: Settings, messages: ChatMessage[]) {
  const endpoint = settings.endpointUrl.trim();
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const claudeMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  const requestBody = {
    model: settings.model,
    max_tokens: 4000,
    temperature: settings.temperature,
    system,
    messages: claudeMessages,
    ...parseExtraRequestParams(settings.extraRequestParams),
  };
  const startedAt = Date.now();
  logLlmRequest("anthropic-messages", endpoint, requestBody);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });
  const responseText = await response.text();
  logLlmResponse("anthropic-messages", endpoint, response.status, responseText, Date.now() - startedAt);

  if (!response.ok) {
    throw new Error(`Anthropic Messages request failed: ${response.status} ${endpoint} ${responseText}`);
  }

  const data = JSON.parse(responseText) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("Claude API returned empty content.");
  return text;
}

function parseModelJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(cleaned);
}

function logLlmRequest(format: string, endpoint: string, body: unknown) {
  console.log(`[judge][llm][${format}] request ${endpoint}`);
  console.log(JSON.stringify(maskSecrets(body), null, 2));
}

function logLlmResponse(format: string, endpoint: string, status: number, body: string, durationMs: number) {
  console.log(`[judge][llm][${format}] response ${status} ${endpoint} ${durationMs}ms`);
  console.log(body.slice(0, 4000));
}

function parseExtraRequestParams(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra request params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /key|token|authorization|secret/i.test(key) ? "***" : maskSecrets(entry),
      ]),
    );
  }
  return value;
}
