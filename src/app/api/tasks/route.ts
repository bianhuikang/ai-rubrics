import { NextResponse } from "next/server";
import { z } from "zod";
import { createTask, listTasks } from "@/lib/db";

export const runtime = "nodejs";

const taskSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().min(1).optional(),
  prompt: z.string(),
  urls: z.array(z.string().url()).min(1),
  mode: z.enum(["auto", "manual"]).default("manual"),
  rubrics: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        evidenceHints: z.array(z.string()).default([]),
      }),
    )
    .optional(),
});

export async function GET() {
  return NextResponse.json({ tasks: listTasks() });
}

export async function POST(request: Request) {
  const body = await request.json();
  const input = taskSchema.parse(body);
  if (!input.prompt.trim() && !input.rubrics?.length) {
    return NextResponse.json({ error: "需要自动生成 Rubrics 时请填写 Prompt；手填 Rubrics 时可以不填。" }, { status: 400 });
  }
  const task = createTask(input);
  return NextResponse.json(task);
}
