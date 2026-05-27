import { NextResponse } from "next/server";
import { z } from "zod";
import { testModelConnection } from "@/lib/llm";

export const runtime = "nodejs";

const settingsSchema = z.object({
  apiFormat: z.enum(["openai-chat-completions", "anthropic-messages"]),
  endpointUrl: z.string().trim(),
  apiKey: z.string(),
  model: z.string(),
  temperature: z.coerce.number().min(0).max(2),
  extraRequestParams: z.string().min(0).default("{}"),
  rubricPrompt: z.string(),
  scoringPrompt: z.string(),
});

function validateExtraParams(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "{}";
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extraRequestParams must be a JSON object");
  }
  return JSON.stringify(parsed, null, 2);
}

export async function POST(request: Request) {
  try {
    const settings = settingsSchema.parse(await request.json());
    settings.extraRequestParams = validateExtraParams(settings.extraRequestParams);
    if (!settings.endpointUrl) {
      return NextResponse.json({ ok: false, error: "请填写完整接口地址（Endpoint URL）" });
    }
    if (!settings.model.trim()) {
      return NextResponse.json({ ok: false, error: "请填写模型名称（Model）" });
    }
    const result = await testModelConnection(settings);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}
