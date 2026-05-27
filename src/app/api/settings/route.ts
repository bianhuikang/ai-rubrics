import { NextResponse } from "next/server";
import { z } from "zod";
import {
  activateSettingsConfig,
  createSettingsConfig,
  deleteSettingsConfig,
  getActiveSettingsConfig,
  getManualCheckMode,
  listSettingsConfigs,
  saveSettings,
} from "@/lib/db";
import type { Settings } from "@/lib/types";

export const runtime = "nodejs";

const settingsSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).optional(),
  apiFormat: z.enum(["openai-chat-completions", "anthropic-messages"]),
  endpointUrl: z.string().trim(),
  apiKey: z.string(),
  model: z.string(),
  temperature: z.coerce.number().min(0).max(2),
  extraRequestParams: z.string().min(0).default("{}"),
  rubricPrompt: z.string(),
  scoringPrompt: z.string(),
});

const createConfigSchema = z.object({
  name: z.string().trim().min(1),
  settings: settingsSchema.omit({ id: true, name: true }).optional(),
});

const activateConfigSchema = z.object({
  id: z.string().min(1),
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

function settingsResponse() {
  const active = getActiveSettingsConfig();
  const { id: _id, name: _name, isActive: _isActive, updatedAt: _updatedAt, ...settings } = active;
  return {
    settings: settings satisfies Settings,
    configs: listSettingsConfigs(),
    activeConfigId: active.id,
    manualCheckMode: getManualCheckMode(),
  };
}

export async function GET() {
  return NextResponse.json(settingsResponse());
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const settings = settingsSchema.parse(body);
    settings.extraRequestParams = validateExtraParams(settings.extraRequestParams);
    saveSettings(settings);
    return NextResponse.json(settingsResponse());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = createConfigSchema.parse(await request.json());
    const settings = body.settings
      ? {
          ...body.settings,
          extraRequestParams: validateExtraParams(body.settings.extraRequestParams),
        }
      : undefined;
    createSettingsConfig({ name: body.name, settings });
    return NextResponse.json(settingsResponse());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = activateConfigSchema.parse(await request.json());
    activateSettingsConfig(body.id);
    return NextResponse.json(settingsResponse());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    deleteSettingsConfig(id);
    return NextResponse.json(settingsResponse());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
