import { NextResponse } from "next/server";
import { z } from "zod";
import { getTask, updateTask } from "@/lib/db";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  urls: z.array(z.string().url()).min(1).optional(),
  mode: z.enum(["auto", "manual"]).optional(),
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

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  const patch = updateSchema.parse(await request.json());
  return NextResponse.json(updateTask(id, patch.rubrics ? { ...patch, rubricsSource: "user" } : patch));
}
