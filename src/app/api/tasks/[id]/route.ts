import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteTask, getTask, updateTask } from "@/lib/db";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().optional(),
  urls: z.array(z.string().url()).min(1).optional(),
  mode: z.enum(["auto", "manual"]).optional(),
  qualityMode: z.boolean().optional(),
  qualityScoreText: z.string().optional(),
  qualityMatrix: z.array(z.array(z.number().int().min(0).max(1))).optional(),
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
  const rubricsChanged = patch.rubrics ? JSON.stringify(patch.rubrics) !== JSON.stringify(task.rubrics) : false;
  return NextResponse.json(
    updateTask(
      id,
      patch.rubrics
        ? { ...patch, rubricsSource: "user", rubricsModified: task.rubricsModified || rubricsChanged }
        : patch,
    ),
  );
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  deleteTask(id);
  return NextResponse.json({ ok: true });
}
