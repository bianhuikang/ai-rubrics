import { NextResponse } from "next/server";
import { z } from "zod";
import { createTask, listTasks } from "@/lib/db";

export const runtime = "nodejs";

const taskSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1),
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
  if (input.rubrics?.length) {
    const length = input.rubrics.map((rubric) => rubric.description).join("").replace(/\s/g, "").length;
    if (length <= 50) {
      return NextResponse.json({ error: "用户输入的 Rubrics 需要超过 50 个字；不填则自动生成。" }, { status: 400 });
    }
  }
  const task = createTask(input);
  return NextResponse.json(task);
}
