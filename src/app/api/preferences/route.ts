import { NextResponse } from "next/server";
import { z } from "zod";
import { getManualCheckMode, saveManualCheckMode } from "@/lib/db";

export const runtime = "nodejs";

const preferencesSchema = z.object({
  manualCheckMode: z.boolean(),
});

export async function GET() {
  return NextResponse.json({ manualCheckMode: getManualCheckMode() });
}

export async function PATCH(request: Request) {
  const body = preferencesSchema.parse(await request.json());
  return NextResponse.json({ manualCheckMode: saveManualCheckMode(body.manualCheckMode) });
}
