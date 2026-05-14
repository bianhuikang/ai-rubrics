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
  qualityReviewEnabled: z.boolean().optional(),
  qualityReviewScoreText: z.string().optional(),
  qualityReviewReasonText: z.string().optional(),
  qualityReviewScoreMatrix: z.array(z.array(z.number().int().min(0).max(1))).optional(),
  qualityReviewReasonMatrix: z.array(z.array(z.string())).optional(),
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
  const hasQualityReviewScore = Boolean(input.qualityReviewScoreText?.trim());
  const hasQualityReviewReason = Boolean(input.qualityReviewReasonText?.trim());
  if (hasQualityReviewScore !== hasQualityReviewReason) {
    throw new Error("质检评分和质检理由必须同时填写，或同时留空。");
  }
  if (!hasQualityReviewScore) return;
  if (!input.rubrics?.length) {
    throw new Error("填写质检评分和质检理由时，必须同时填写 Rubrics。");
  }
  if (!input.qualityReviewEnabled || !input.qualityReviewScoreMatrix || !input.qualityReviewReasonMatrix) {
    throw new Error("质检核对配置不完整。");
  }
  if (input.qualityReviewScoreMatrix.length !== input.urls.length) {
    throw new Error(`质检评分需要 ${input.urls.length} 行，对应当前任务的 ${input.urls.length} 个页面。`);
  }
  if (input.qualityReviewReasonMatrix.length !== input.urls.length) {
    throw new Error(`质检理由需要 ${input.urls.length} 行，对应当前任务的 ${input.urls.length} 个页面。`);
  }
  input.qualityReviewScoreMatrix.forEach((row, rowIndex) => {
    if (row.length !== input.rubrics!.length) {
      throw new Error(`质检评分第 ${rowIndex + 1} 行需要 ${input.rubrics!.length} 列。`);
    }
  });
  input.qualityReviewReasonMatrix.forEach((row, rowIndex) => {
    if (row.length !== input.rubrics!.length) {
      throw new Error(`质检理由第 ${rowIndex + 1} 行需要 ${input.rubrics!.length} 列。`);
    }
    row.forEach((reason, reasonIndex) => {
      if (!reason.trim()) {
        throw new Error(`质检理由第 ${rowIndex + 1} 行第 ${reasonIndex + 1} 列不能为空。`);
      }
    });
  });
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
