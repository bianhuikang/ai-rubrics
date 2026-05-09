import { z } from "zod";
import type { EvidencePlanStep, PageEvidence, Rubric, Settings } from "./types";
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
    .min(4)
    .max(10),
});

const scoreSchema = z.object({
  scores: z.array(z.number().int().min(0).max(1)),
  reasons: z.array(z.string()),
});

const evidencePlanSchema = z.object({
  plans: z
    .array(
      z.object({
        rubricId: z.string().min(1),
        action: z.enum([
          "scanText",
          "checkLinks",
          "checkControls",
          "checkIframe",
          "readLocalStorage",
          "click",
          "hover",
          "fill",
          "press",
          "drag",
          "reload",
          "setViewport",
          "compareState",
        ]),
        targetHints: z.array(z.string()).default([]),
        value: z.string().optional(),
        key: z.string().optional(),
        repeat: z.number().int().min(1).max(20).optional(),
        note: z.string().optional(),
      }),
    )
    .max(32),
});

const RUBRIC_JSON_OUTPUT_INSTRUCTION = `Output strict JSON only. Do not include Markdown, prose, comments, or code fences.
The JSON object must have exactly this top-level shape:
{
  "rubrics": [
    {
      "id": "R1",
      "name": "short label",
      "description": "one sentence acceptance requirement",
      "evidenceHints": ["observable evidence hint"]
    }
  ]
}
Rules for the schema:
- rubrics must contain 4-10 items.
- id must be R1, R2, R3, ... in order.
- name must be a short label.
- description must be one checklist-style sentence.
- evidenceHints must be an array of strings; use [] if no useful hints exist.`;

const SCORING_JSON_OUTPUT_INSTRUCTION = `Output strict JSON only. Do not include Markdown, prose, comments, or code fences.
The JSON object must have exactly this top-level shape:
{
  "scores": [1, 0, 1],
  "reasons": ["short evidence reason for rubric 1", "short evidence reason for rubric 2", "short evidence reason for rubric 3"]
}
Rules for the schema:
- scores must contain exactly one integer per rubric.
- each score must be 1 or 0.
- reasons must contain exactly one string per rubric.
- each reason must briefly name the key evidence for its corresponding score.`;

export async function generateRubrics(
  settings: Settings,
  prompt: string,
  candidates: Array<{
    url: string;
    summary: unknown;
  }> = [],
): Promise<Rubric[]> {
  const raw = await callJsonModel(settings, [
    {
      role: "system",
      content: [settings.rubricPrompt.trim(), RUBRIC_JSON_OUTPUT_INSTRUCTION].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          prompt,
          candidates,
          outputSchema: {
            rubrics: [
              {
                id: "R1",
                name: "short label",
                description: "one sentence acceptance requirement",
                evidenceHints: ["observable evidence hint"],
              },
            ],
          },
          instruction:
            "Generate 4-10 medium-granularity client-acceptance rubrics from the original prompt first; candidate evidence, if present, is only a visibility hint and must not introduce new requirements. Keep only the most important explicit requirements that materially affect task completion or result usability. Each rubric must check exactly one thing, be stable to judge from code, page behavior, output, or static evidence, and avoid subjective language such as beautiful, friendly, smooth, modern, clear structure, modular design, or code style. Remove duplicate requirements with the same meaning. Each description must be exactly one checklist-style sentence, without score 1/0 explanations or boundary prose. Prefer rubrics about operable workflows that Playwright can verify: buttons/links can be clicked, forms can be filled and submitted/saved, saved or newly created content appears on the page, drag/drop changes page state, localStorage persists a user choice, URL/route or visible state changes after interaction, basic responsive layout works, and required controls/resources exist. Do not create rubrics that require subjective human judgment or unstable automation, such as proving audio is audible, exact hidden easter-egg triggering, complex drag paths, latest-content freshness, animation smoothness, or all hover details. If the prompt includes such hard-to-verify requirements, rewrite them as observable alternatives, such as resource presence, control presence, or state change after interaction.",
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

export async function generateEvidencePlan(settings: Settings, prompt: string, rubrics: Rubric[]): Promise<EvidencePlanStep[]> {
  const raw = await callJsonModel(settings, [
    {
      role: "system",
      content:
        "You design safe Playwright evidence collection plans for frontend acceptance rubrics. Output strict JSON only. Do not write JavaScript code. Only use the allowed action names.",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          prompt,
          rubrics,
          allowedActions: [
            "scanText",
            "checkLinks",
            "checkControls",
            "checkIframe",
            "readLocalStorage",
            "click",
            "hover",
            "fill",
            "press",
            "drag",
            "reload",
            "setViewport",
            "compareState",
          ],
          instruction:
            "Create 1-4 concise evidence steps per rubric when useful. Prefer actionable workflow checks: click buttons/links, fill form fields, press submit/save, verify the saved/created content appears, drag draggable items, read localStorage after theme/save actions, and compare visible state before/after. Use targetHints as short visible text, aria-label, href fragments, ids/classes, or domain words that a generic executor can search for. Prefer checkLinks/checkControls/checkIframe/scanText/readLocalStorage for static evidence; use click/hover/fill/press/drag/reload/setViewport/compareState only for simple observable behavior. Do not plan checks that require listening to audio, proving content freshness, exact complex drag paths, subjective animation quality, or hidden easter eggs unless the rubric has already been rewritten as resource/control/state-change evidence. Do not invent selectors that are not implied by the rubric. Output JSON as {\"plans\":[...]} only.",
        },
        null,
        2,
      ),
    },
  ]);

  return normalizeEvidencePlan(parseModelJson(raw), rubrics);
}

function normalizeEvidencePlan(value: unknown, rubrics: Rubric[]): EvidencePlanStep[] {
  const rawPlans = extractPlanArray(value);
  const rubricIds = new Set(rubrics.map((rubric) => rubric.id));
  const normalized: EvidencePlanStep[] = [];

  for (const rawPlan of rawPlans) {
    if (!rawPlan || typeof rawPlan !== "object") continue;
    const entry = rawPlan as Record<string, unknown>;
    const rubricId = normalizeRubricId(entry, rubrics);
    const action = normalizeEvidenceAction(entry.action ?? entry.type ?? entry.check ?? entry.method);
    if (!rubricId || !rubricIds.has(rubricId) || !action) continue;

    normalized.push({
      rubricId,
      action,
      targetHints: normalizeTargetHints(entry.targetHints ?? entry.hints ?? entry.targets ?? entry.target ?? entry.selector ?? entry.text),
      value: normalizeOptionalString(entry.value ?? entry.input ?? entry.textToFill),
      key: normalizeOptionalString(entry.key ?? entry.pressKey),
      repeat: normalizeRepeat(entry.repeat ?? entry.times ?? entry.clicks),
      note: normalizeOptionalString(entry.note ?? entry.goal ?? entry.description),
    });
  }

  return normalized.slice(0, 32);
}

function extractPlanArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["plans", "steps", "evidencePlan", "plan", "checks", "actions"]) {
    const candidate = object[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeRubricId(entry: Record<string, unknown>, rubrics: Rubric[]) {
  const direct = normalizeOptionalString(entry.rubricId ?? entry.rubric_id ?? entry.id);
  if (direct) {
    const exact = rubrics.find((rubric) => rubric.id.toLowerCase() === direct.toLowerCase());
    if (exact) return exact.id;
    const numberMatch = direct.match(/\d+/);
    if (numberMatch) {
      const byNumber = rubrics[Number(numberMatch[0]) - 1];
      if (byNumber) return byNumber.id;
    }
  }

  const rubricText = normalizeOptionalString(entry.rubric ?? entry.name ?? entry.description);
  if (!rubricText) return "";
  return rubrics.find((rubric) => rubricText.includes(rubric.id) || rubricText.includes(rubric.name) || rubricText.includes(rubric.description.slice(0, 16)))?.id || "";
}

function normalizeEvidenceAction(value: unknown): EvidencePlanStep["action"] | "" {
  const raw = normalizeOptionalString(value).replace(/[\s_-]+/g, "").toLowerCase();
  const aliases: Record<string, EvidencePlanStep["action"]> = {
    scantext: "scanText",
    text: "scanText",
    checktext: "scanText",
    findtext: "scanText",
    checklinks: "checkLinks",
    link: "checkLinks",
    links: "checkLinks",
    checklink: "checkLinks",
    checkcontrols: "checkControls",
    controls: "checkControls",
    control: "checkControls",
    checkbuttons: "checkControls",
    checkform: "checkControls",
    checkiframe: "checkIframe",
    iframe: "checkIframe",
    checkembed: "checkIframe",
    checkvideo: "checkIframe",
    readlocalstorage: "readLocalStorage",
    checklocalstorage: "readLocalStorage",
    localstorage: "readLocalStorage",
    click: "click",
    hover: "hover",
    fill: "fill",
    input: "fill",
    type: "fill",
    press: "press",
    keypress: "press",
    drag: "drag",
    draganddrop: "drag",
    draggable: "drag",
    drop: "drag",
    reload: "reload",
    refresh: "reload",
    setviewport: "setViewport",
    viewport: "setViewport",
    mobile: "setViewport",
    tablet: "setViewport",
    comparestate: "compareState",
    compare: "compareState",
    waitandcompare: "compareState",
  };
  return aliases[raw] || "";
}

function normalizeTargetHints(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values
    .flatMap((item) => (typeof item === "string" ? item.split("|") : [String(item)]))
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function normalizeRepeat(value: unknown) {
  if (value == null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(String(value).match(/\d+/)?.[0] ?? NaN);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(1, Math.min(20, Math.round(number)));
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

  const scoringMessages: ChatMessage[] = [
    {
      role: "system",
      content: [input.settings.scoringPrompt.trim(), SCORING_JSON_OUTPUT_INSTRUCTION].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          prompt: input.prompt,
          rubrics: input.rubrics,
          evidence: evidenceForModel,
          outputContract: `Return {"scores": number[], "reasons": string[]} with both arrays exactly length ${input.rubrics.length}; every score must be 0 or 1.`,
        },
        null,
        2,
      ),
    },
  ];
  logFinalScoringPrompt(scoringMessages, {
    prompt: input.prompt,
    rubrics: input.rubrics,
    evidence: evidenceForModel,
  });

  const raw = await callJsonModel(input.settings, scoringMessages);

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
  const candidate = firstBrace >= 0 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
  try {
    return JSON.parse(candidate);
  } catch (firstError) {
    const repaired = repairModelJson(candidate);
    try {
      return JSON.parse(repaired);
    } catch {
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`Model returned invalid JSON: ${message}. Raw content starts with: ${candidate.slice(0, 500)}`);
    }
  }
}

function repairModelJson(value: string) {
  const withoutTrailingCommas = value.replace(/,\s*([}\]])/g, "$1");
  const output: string[] = [];
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;

  for (const char of withoutTrailingCommas) {
    output.push(char);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expectedOpen = char === "}" ? "{" : "[";
      const expectedClose = char === "}" ? "]" : "}";
      while (stack.length && stack[stack.length - 1] !== expectedOpen) {
        stack.pop();
        output.splice(output.length - 1, 0, expectedClose);
      }
      if (stack[stack.length - 1] === expectedOpen) stack.pop();
    }
  }

  while (stack.length) {
    const open = stack.pop();
    output.push(open === "[" ? "]" : "}");
  }

  return output.join("").replace(/,\s*([}\]])/g, "$1");
}

function logLlmRequest(format: string, endpoint: string, body: unknown) {
  console.log(`[judge][llm][${format}] request ${endpoint}`);
  console.log(JSON.stringify(maskSecrets(body), null, 2));
}

function logFinalScoringPrompt(
  messages: ChatMessage[],
  input: {
    prompt: string;
    rubrics: Rubric[];
    evidence: PageEvidence;
  },
) {
  console.log("\n[judge][scoring][final-prompt] ===== BEGIN =====");
  console.log(`\n[SYSTEM]\n${messages.find((message) => message.role === "system")?.content ?? ""}`);
  console.log("\n[USER SUMMARY]");
  console.log(
    JSON.stringify(
      {
        prompt: input.prompt,
        rubrics: input.rubrics,
        evidence: summarizeEvidenceForLog(input.evidence),
      },
      null,
      2,
    ),
  );
  if (process.env.LOG_FULL_SCORING_PROMPT === "1") {
    console.log("\n[USER FULL]");
    console.log(messages.find((message) => message.role === "user")?.content ?? "");
  }
  console.log("\n[judge][scoring][final-prompt] ===== END =====\n");
}

function summarizeEvidenceForLog(evidence: PageEvidence) {
  return {
    url: evidence.url,
    finalUrl: evidence.finalUrl,
    title: evidence.title,
    visibleTextSample: evidence.visibleText.slice(0, 1200),
    requirements: evidence.requirements,
    requiredElements: evidence.requiredElements,
    controls: evidence.controls.slice(0, 40),
    layout: evidence.layout,
    visual: evidence.visual,
    technology: evidence.technology,
    responsive: evidence.responsive,
    motion: evidence.motion,
    interactions: evidence.interactions,
    rubricEvidence: evidence.rubricEvidence,
    errors: evidence.errors,
    htmlSampleLength: evidence.htmlSample.length,
    visibleTextLength: evidence.visibleText.length,
  };
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
