import { NextResponse } from "next/server";
import { z } from "zod";
import { createTask, listTasks } from "@/lib/db";

export const runtime = "nodejs";

const taskSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1),
  urls: z.array(z.string().url()).min(1),
});

export async function GET() {
  return NextResponse.json({ tasks: listTasks() });
}

export async function POST(request: Request) {
  const body = await request.json();
  const input = taskSchema.parse(body);
  const task = createTask(input);
  return NextResponse.json(task);
}
