import { NextResponse } from "next/server";
import { z } from "zod";
import { createTask, getTask, listTasks } from "@/lib/db";

export const runtime = "nodejs";

const taskSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().min(1).optional(),
  prompt: z.string(),
  urls: z.array(z.string().url()).min(1),
  mode: z.enum(["auto", "manual"]).default("manual"),
  skipIfExists: z.boolean().optional(),
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

const batchTaskSchema = z.object({
  tasks: z.array(taskSchema).min(1),
});

type TaskInput = z.infer<typeof taskSchema>;

function validateTaskInput(input: TaskInput) {
  if (!input.prompt.trim() && !input.rubrics?.length) {
    throw new Error("需要自动生成 Rubrics 时请填写 Prompt；手填 Rubrics 时可以不填。");
  }
}

export async function GET() {
  return NextResponse.json({ tasks: listTasks() });
}

export async function POST(request: Request) {
  const body = await request.json();
  const batchInput = batchTaskSchema.safeParse(body);

  if (batchInput.success) {
    const createdTasks = [];
    const duplicateIds = new Set<string>();
    const errors: Array<{ id: string; message: string }> = [];
    const seenIds = new Set<string>();

    for (const input of batchInput.data.tasks) {
      const normalizedId = input.id?.trim() ?? "";

      try {
        validateTaskInput(input);

        if (normalizedId) {
          if (seenIds.has(normalizedId)) {
            duplicateIds.add(normalizedId);
            continue;
          }
          seenIds.add(normalizedId);
        }

        if (input.skipIfExists && normalizedId) {
          const existing = getTask(normalizedId);
          if (existing) {
            duplicateIds.add(normalizedId);
            continue;
          }
        }

        createdTasks.push(createTask(input));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (normalizedId && message.includes("already exists")) {
          duplicateIds.add(normalizedId);
          continue;
        }
        errors.push({ id: normalizedId, message });
      }
    }

    return NextResponse.json({
      createdTasks,
      duplicateIds: Array.from(duplicateIds),
      errors,
    });
  }

  const input = taskSchema.parse(body);
  validateTaskInput(input);
  if (input.skipIfExists && input.id) {
    const existing = getTask(input.id);
    if (existing) {
      return NextResponse.json({ skipped: true, task: existing });
    }
  }
  const task = createTask(input);
  return NextResponse.json(task);
}
