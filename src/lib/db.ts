import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUBRIC_PROMPT, DEFAULT_SCORING_PROMPT } from "./default-prompts";
import type { PageEvidence, QualityReviewResult, ScoreResult, Settings, SettingsConfig, Task, TaskLog, TaskMode, TaskStatus } from "./types";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "app.db");

const EMPTY_MODEL_CONFIG = {
  name: "Default config",
  provider: "openai-chat-completions",
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.2,
  extraRequestParams: "{}",
};

export type ManualDraftRecord = {
  taskId: string;
  url: string;
  scores: number[];
  reasons: string[];
  answeredCount: number;
  createdAt: string;
  updatedAt: string;
};

export type QualityReviewDraftRecord = {
  taskId: string;
  url: string;
  scores: number[];
  reasons: string[];
  answeredCount: number;
  createdAt: string;
  updatedAt: string;
};

let db: Database.Database | undefined;

function now() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getDb() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!db) {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        baseUrl TEXT NOT NULL,
        apiKey TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL NOT NULL,
        extraRequestParams TEXT NOT NULL DEFAULT '{}',
        rubricPrompt TEXT NOT NULL,
        scoringPrompt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        urls TEXT NOT NULL,
        rubrics TEXT NOT NULL,
        rubricsSource TEXT NOT NULL DEFAULT 'none',
        rubricsModified INTEGER NOT NULL DEFAULT 0,
        qualityMode INTEGER NOT NULL DEFAULT 0,
        qualityScoreText TEXT NOT NULL DEFAULT '',
        qualityMatrix TEXT NOT NULL DEFAULT '[]',
        qualityReviewEnabled INTEGER NOT NULL DEFAULT 0,
        qualityReviewScoreText TEXT NOT NULL DEFAULT '',
        qualityReviewReasonText TEXT NOT NULL DEFAULT '',
        qualityReviewScoreMatrix TEXT NOT NULL DEFAULT '[]',
        qualityReviewReasonMatrix TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL,
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        url TEXT NOT NULL,
        scores TEXT NOT NULL,
        reasons TEXT NOT NULL,
        evidence TEXT NOT NULL,
        rawResponse TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_logs (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        message TEXT NOT NULL,
        extra TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS manual_drafts (
        taskId TEXT NOT NULL,
        url TEXT NOT NULL,
        scores TEXT NOT NULL,
        reasons TEXT NOT NULL,
        answeredCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (taskId, url),
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quality_review_results (
        taskId TEXT NOT NULL,
        url TEXT NOT NULL,
        scores TEXT NOT NULL,
        reasons TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (taskId, url),
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quality_review_drafts (
        taskId TEXT NOT NULL,
        url TEXT NOT NULL,
        scores TEXT NOT NULL,
        reasons TEXT NOT NULL,
        answeredCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (taskId, url),
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        baseUrl TEXT NOT NULL,
        apiKey TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL NOT NULL,
        extraRequestParams TEXT NOT NULL DEFAULT '{}',
        rubricPrompt TEXT NOT NULL,
        scoringPrompt TEXT NOT NULL,
        isActive INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "extraRequestParams")) {
      db.exec("ALTER TABLE settings ADD COLUMN extraRequestParams TEXT NOT NULL DEFAULT '{}'");
    }
    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "rubricsSource")) {
      db.exec("ALTER TABLE tasks ADD COLUMN rubricsSource TEXT NOT NULL DEFAULT 'generated'");
    }
    if (!taskColumns.some((column) => column.name === "mode")) {
      db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!taskColumns.some((column) => column.name === "rubricsModified")) {
      db.exec("ALTER TABLE tasks ADD COLUMN rubricsModified INTEGER NOT NULL DEFAULT 0");
    }
    if (!taskColumns.some((column) => column.name === "qualityMode")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityMode INTEGER NOT NULL DEFAULT 0");
    }
    if (!taskColumns.some((column) => column.name === "qualityScoreText")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityScoreText TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.some((column) => column.name === "qualityMatrix")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityMatrix TEXT NOT NULL DEFAULT '[]'");
    }
    if (!taskColumns.some((column) => column.name === "qualityReviewEnabled")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityReviewEnabled INTEGER NOT NULL DEFAULT 0");
    }
    if (!taskColumns.some((column) => column.name === "qualityReviewScoreText")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityReviewScoreText TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.some((column) => column.name === "qualityReviewReasonText")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityReviewReasonText TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.some((column) => column.name === "qualityReviewScoreMatrix")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityReviewScoreMatrix TEXT NOT NULL DEFAULT '[]'");
    }
    if (!taskColumns.some((column) => column.name === "qualityReviewReasonMatrix")) {
      db.exec("ALTER TABLE tasks ADD COLUMN qualityReviewReasonMatrix TEXT NOT NULL DEFAULT '[]'");
    }

    const existing = db.prepare("SELECT id FROM settings WHERE id = 1").get();
    if (!existing) {
      db.prepare(`
        INSERT INTO settings (id, provider, baseUrl, apiKey, model, temperature, extraRequestParams, rubricPrompt, scoringPrompt, updatedAt)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        EMPTY_MODEL_CONFIG.provider,
        EMPTY_MODEL_CONFIG.baseUrl,
        EMPTY_MODEL_CONFIG.apiKey,
        EMPTY_MODEL_CONFIG.model,
        EMPTY_MODEL_CONFIG.temperature,
        EMPTY_MODEL_CONFIG.extraRequestParams,
        DEFAULT_RUBRIC_PROMPT,
        DEFAULT_SCORING_PROMPT,
        now(),
      );
    } else {
      db.prepare("UPDATE settings SET provider = ? WHERE provider = ?").run(
        "openai-chat-completions",
        "openai-compatible",
      );
      db.prepare("UPDATE settings SET provider = ? WHERE provider = ?").run("anthropic-messages", "claude");
      db.prepare("UPDATE settings SET baseUrl = ? WHERE provider = ? AND baseUrl = ?").run(
        "https://api.anthropic.com/v1/messages",
        "anthropic-messages",
        "https://api.anthropic.com",
      );
      db.prepare("UPDATE settings SET baseUrl = ? WHERE provider = ? AND baseUrl = ?").run(
        "https://api.anthropic.com/v1/messages",
        "anthropic-messages",
        "https://api.anthropic.com/v1",
      );
      db.prepare(
        `
        UPDATE settings
        SET rubricPrompt = ?
        WHERE rubricPrompt LIKE ?
      `,
      ).run(
        DEFAULT_RUBRIC_PROMPT,
        "你是一个前端网页产物评测专家。你会收到用户给出的需求 prompt，以及多个候选网页产物的 Playwright 证据摘要。请基于需求和候选产物差异，生成 4-10 条中等粒度 rubrics%",
      );
      db.prepare(
        `
        UPDATE settings
        SET rubricPrompt = ?
        WHERE rubricPrompt LIKE ?
      `,
      ).run(
        DEFAULT_RUBRIC_PROMPT,
        "你是一个前端网页产物评测专家。你会收到用户给出的需求 prompt，以及多个候选网页产物的 Playwright 证据摘要。请基于需求和候选产物差异，生成 7-10 条中等粒度 rubrics%",
      );
    }

    const configCount = db.prepare("SELECT COUNT(*) AS count FROM model_configs").get() as { count: number };
    if (!configCount.count) {
      const timestamp = now();
      db.prepare(`
        INSERT INTO model_configs (
          id, name, provider, baseUrl, apiKey, model, temperature, extraRequestParams,
          rubricPrompt, scoringPrompt, isActive, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        crypto.randomUUID(),
        EMPTY_MODEL_CONFIG.name,
        EMPTY_MODEL_CONFIG.provider,
        EMPTY_MODEL_CONFIG.baseUrl,
        EMPTY_MODEL_CONFIG.apiKey,
        EMPTY_MODEL_CONFIG.model,
        EMPTY_MODEL_CONFIG.temperature,
        EMPTY_MODEL_CONFIG.extraRequestParams,
        DEFAULT_RUBRIC_PROMPT,
        DEFAULT_SCORING_PROMPT,
        timestamp,
        timestamp,
      );
    }
    const manualCheckMode = db.prepare("SELECT key FROM app_preferences WHERE key = ?").get("manualCheckMode");
    if (!manualCheckMode) {
      db.prepare("INSERT INTO app_preferences (key, value, updatedAt) VALUES (?, ?, ?)").run(
        "manualCheckMode",
        "true",
        now(),
      );
    }

    for (const oldPromptPattern of [
      "你是一个前端网页产物评测专家。你会收到用户给出的需求 prompt，以及多个候选网页产物的 Playwright 证据摘要。请基于需求和候选产物差异，生成 4-10 条中等粒度 rubrics%",
      "你是一个前端网页产物评测专家。你会收到用户给出的需求 prompt，以及多个候选网页产物的 Playwright 证据摘要。请基于需求和候选产物差异，生成 7-10 条中等粒度 rubrics%",
      "你是一个前端网页产物评测专家。你会收到用户给出的需求 prompt，以及多个候选网页产物的 Playwright 证据摘要。请基于原始需求和候选产物差异，生成 5-12 条中等粒度 rubrics%",
      "你是甲方前端网页产物验收 rubrics 标注员。你会收到需求 prompt 和多个候选网页产物的 Playwright 证据摘要。请生成 6-9 条“甲方验收表格风格”的中等偏粗粒度 rubrics%",
      "你是甲方前端网页产物验收 rubrics 标注员。你会收到需求 prompt。请先只基于原始需求生成 5-9 条“甲方验收表格风格”的中等偏粗粒度 rubrics%",
      "你是甲方前端网页产物验收 rubrics 标注员。你会收到需求 prompt。请先只基于原始需求生成 4-10 条“甲方验收表格风格”的中等粒度 rubrics%",
    ]) {
      db.prepare("UPDATE settings SET rubricPrompt = ? WHERE rubricPrompt LIKE ?").run(DEFAULT_RUBRIC_PROMPT, oldPromptPattern);
      db.prepare("UPDATE model_configs SET rubricPrompt = ? WHERE rubricPrompt LIKE ?").run(DEFAULT_RUBRIC_PROMPT, oldPromptPattern);
    }
    db.prepare("UPDATE settings SET scoringPrompt = ? WHERE scoringPrompt LIKE ?").run(
      DEFAULT_SCORING_PROMPT,
      "你是严格的网页产物评测员。你会收到原始需求 prompt、一组 rubrics，以及 Playwright 抓取的页面证据。请逐条判断该网页是否满足每条 rubric%",
    );
    db.prepare("UPDATE model_configs SET scoringPrompt = ? WHERE scoringPrompt LIKE ?").run(
      DEFAULT_SCORING_PROMPT,
      "你是严格的网页产物评测员。你会收到原始需求 prompt、一组 rubrics，以及 Playwright 抓取的页面证据。请逐条判断该网页是否满足每条 rubric%",
    );
  }

  return db;
}

export function getSettings(): Settings {
  const row = getActiveConfigRow();
  return rowToSettings(row);
}

export function listSettingsConfigs(): SettingsConfig[] {
  const rows = getDb()
    .prepare("SELECT * FROM model_configs ORDER BY createdAt ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToSettingsConfig);
}

export function getActiveSettingsConfig(): SettingsConfig {
  return rowToSettingsConfig(getActiveConfigRow());
}

export function createSettingsConfig(input: { name: string; settings?: Settings }): SettingsConfig {
  const settings = input.settings ?? getSettings();
  const id = crypto.randomUUID();
  const timestamp = now();
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE model_configs SET isActive = 0").run();
    db.prepare(`
      INSERT INTO model_configs (
        id, name, provider, baseUrl, apiKey, model, temperature, extraRequestParams,
        rubricPrompt, scoringPrompt, isActive, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      input.name.trim(),
      settings.apiFormat,
      settings.endpointUrl,
      settings.apiKey,
      settings.model,
      settings.temperature,
      settings.extraRequestParams,
      settings.rubricPrompt,
      settings.scoringPrompt,
      timestamp,
      timestamp,
    );
  });
  transaction();
  return getActiveSettingsConfig();
}

export function activateSettingsConfig(id: string): SettingsConfig {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM model_configs WHERE id = ?").get(id);
  if (!existing) throw new Error("Model config not found");
  const transaction = db.transaction(() => {
    db.prepare("UPDATE model_configs SET isActive = 0").run();
    db.prepare("UPDATE model_configs SET isActive = 1, updatedAt = ? WHERE id = ?").run(now(), id);
  });
  transaction();
  return getActiveSettingsConfig();
}

export function deleteSettingsConfig(id: string): SettingsConfig {
  const db = getDb();
  const rows = listSettingsConfigs();
  if (rows.length <= 1) throw new Error("At least one model config is required");
  const target = rows.find((config) => config.id === id);
  if (!target) throw new Error("Model config not found");
  db.prepare("DELETE FROM model_configs WHERE id = ?").run(id);
  if (target.isActive) {
    const next = listSettingsConfigs()[0];
    if (next) activateSettingsConfig(next.id);
  }
  return getActiveSettingsConfig();
}

function rowToSettings(row: Record<string, unknown>): Settings {
  return {
    apiFormat: row.provider as Settings["apiFormat"],
    endpointUrl: String(row.baseUrl),
    apiKey: String(row.apiKey),
    model: String(row.model),
    temperature: Number(row.temperature),
    extraRequestParams: String(row.extraRequestParams ?? "{}"),
    rubricPrompt: String(row.rubricPrompt),
    scoringPrompt: String(row.scoringPrompt),
  };
}

function rowToSettingsConfig(row: Record<string, unknown>): SettingsConfig {
  return {
    ...rowToSettings(row),
    id: String(row.id),
    name: String(row.name),
    isActive: Boolean(row.isActive),
    updatedAt: String(row.updatedAt),
  };
}

function getActiveConfigRow(): Record<string, unknown> {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM model_configs WHERE isActive = 1 ORDER BY updatedAt DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  if (row) return row;
  const fallback = db
    .prepare("SELECT * FROM model_configs ORDER BY updatedAt DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  if (!fallback) throw new Error("No model config found");
  activateSettingsConfig(String(fallback.id));
  return getActiveConfigRow();
}

export function saveSettings(settings: Settings & { id?: string; name?: string }) {
  const current = getActiveSettingsConfig();
  const id = settings.id || current.id;
  const name = settings.name?.trim() || current.name;
  getDb()
    .prepare(`
      UPDATE model_configs
      SET name = ?, provider = ?, baseUrl = ?, apiKey = ?, model = ?, temperature = ?, extraRequestParams = ?, rubricPrompt = ?, scoringPrompt = ?, updatedAt = ?
      WHERE id = ?
    `)
    .run(
      name,
      settings.apiFormat,
      settings.endpointUrl,
      settings.apiKey,
      settings.model,
      settings.temperature,
      settings.extraRequestParams,
      settings.rubricPrompt,
      settings.scoringPrompt,
      now(),
      id,
    );
  const updated = listSettingsConfigs().find((config) => config.id === id);
  if (!updated) throw new Error("Model config not found");
  return updated;
}

export function getManualCheckMode(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM app_preferences WHERE key = ?")
    .get("manualCheckMode") as { value: string } | undefined;
  return row?.value === "true";
}

export function saveManualCheckMode(enabled: boolean): boolean {
  getDb()
    .prepare(
      `
      INSERT INTO app_preferences (key, value, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
    `,
    )
    .run("manualCheckMode", enabled ? "true" : "false", now());
  return enabled;
}

export function listTasks(): Task[] {
  const rows = getDb()
    .prepare(
      `
      SELECT
        tasks.*,
        (SELECT COUNT(*) FROM results WHERE results.taskId = tasks.id) AS resultCount,
        (SELECT COUNT(*) FROM quality_review_results WHERE quality_review_results.taskId = tasks.id) AS qualityReviewResultCount
      FROM tasks
      ORDER BY tasks.createdAt DESC
    `,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTask(id: string): Task | null {
  const row = getDb()
    .prepare(
      `
      SELECT
        tasks.*,
        (SELECT COUNT(*) FROM results WHERE results.taskId = tasks.id) AS resultCount,
        (SELECT COUNT(*) FROM quality_review_results WHERE quality_review_results.taskId = tasks.id) AS qualityReviewResultCount
      FROM tasks
      WHERE tasks.id = ?
    `,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function createTask(input: {
  id?: string;
  name?: string;
  prompt: string;
  urls: string[];
  rubrics?: Task["rubrics"];
  mode?: TaskMode;
  qualityMode?: boolean;
  qualityScoreText?: string;
  qualityMatrix?: number[][];
  qualityReviewEnabled?: boolean;
  qualityReviewScoreText?: string;
  qualityReviewReasonText?: string;
  qualityReviewScoreMatrix?: number[][];
  qualityReviewReasonMatrix?: string[][];
}): Task {
  const id = input.id?.trim() || crypto.randomUUID();
  const existing = getTask(id);
  if (existing) throw new Error(`Task ${id} already exists`);
  const timestamp = now();
  const rubrics = input.rubrics ?? [];
  const rubricsSource = rubrics.length ? "user" : "none";
  getDb()
    .prepare(`
      INSERT INTO tasks (
        id, name, prompt, urls, rubrics, rubricsSource,
        qualityMode, qualityScoreText, qualityMatrix,
        qualityReviewEnabled, qualityReviewScoreText, qualityReviewReasonText, qualityReviewScoreMatrix, qualityReviewReasonMatrix,
        mode, status, error, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `)
    .run(
      id,
      input.name?.trim() || id,
      input.prompt,
      JSON.stringify(input.urls),
      JSON.stringify(rubrics),
      rubricsSource,
      input.qualityMode ? 1 : 0,
      input.qualityScoreText ?? "",
      JSON.stringify(input.qualityMatrix ?? []),
      input.qualityReviewEnabled ? 1 : 0,
      input.qualityReviewScoreText ?? "",
      input.qualityReviewReasonText ?? "",
      JSON.stringify(input.qualityReviewScoreMatrix ?? []),
      JSON.stringify(input.qualityReviewReasonMatrix ?? []),
      input.mode ?? "manual",
      "queued",
      timestamp,
      timestamp,
    );
  return getTask(id)!;
}

export function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | "name"
      | "prompt"
      | "urls"
      | "rubrics"
      | "rubricsSource"
      | "rubricsModified"
      | "qualityMode"
      | "qualityScoreText"
      | "qualityMatrix"
      | "qualityReviewEnabled"
      | "qualityReviewScoreText"
      | "qualityReviewReasonText"
      | "qualityReviewScoreMatrix"
      | "qualityReviewReasonMatrix"
      | "mode"
      | "error"
    >
  > & {
    status?: TaskStatus;
  },
): Task {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  const next = { ...task, ...patch, updatedAt: now() };
  getDb()
    .prepare(`
      UPDATE tasks
      SET name = ?, prompt = ?, urls = ?, rubrics = ?, rubricsSource = ?, rubricsModified = ?, qualityMode = ?, qualityScoreText = ?, qualityMatrix = ?, qualityReviewEnabled = ?, qualityReviewScoreText = ?, qualityReviewReasonText = ?, qualityReviewScoreMatrix = ?, qualityReviewReasonMatrix = ?, mode = ?, status = ?, error = ?, updatedAt = ?
      WHERE id = ?
    `)
    .run(
      next.name,
      next.prompt,
      JSON.stringify(next.urls),
      JSON.stringify(next.rubrics),
      next.rubricsSource,
      next.rubricsModified ? 1 : 0,
      next.qualityMode ? 1 : 0,
      next.qualityScoreText,
      JSON.stringify(next.qualityMatrix),
      next.qualityReviewEnabled ? 1 : 0,
      next.qualityReviewScoreText,
      next.qualityReviewReasonText,
      JSON.stringify(next.qualityReviewScoreMatrix),
      JSON.stringify(next.qualityReviewReasonMatrix),
      next.mode,
      next.status,
      next.error ?? null,
      next.updatedAt,
      id,
    );
  return getTask(id)!;
}

export function deleteResultsForTask(taskId: string) {
  getDb().prepare("DELETE FROM results WHERE taskId = ?").run(taskId);
}

export function deleteResultForTaskUrl(taskId: string, url: string) {
  getDb().prepare("DELETE FROM results WHERE taskId = ? AND url = ?").run(taskId, url);
}

export function deleteQualityReviewResultForTaskUrl(taskId: string, url: string) {
  getDb().prepare("DELETE FROM quality_review_results WHERE taskId = ? AND url = ?").run(taskId, url);
}

export function getManualDraft(taskId: string, url: string): ManualDraftRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM manual_drafts WHERE taskId = ? AND url = ?")
    .get(taskId, url) as Record<string, unknown> | undefined;
  return row ? rowToManualDraft(row) : null;
}

export function listManualDrafts(taskId: string): ManualDraftRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM manual_drafts WHERE taskId = ? ORDER BY updatedAt ASC")
    .all(taskId) as Record<string, unknown>[];
  return rows.map(rowToManualDraft);
}

export function saveManualDraft(input: { taskId: string; url: string; scores: number[]; reasons: string[]; answeredCount: number }) {
  const timestamp = now();
  getDb()
    .prepare(
      `
      INSERT INTO manual_drafts (taskId, url, scores, reasons, answeredCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(taskId, url) DO UPDATE SET
        scores = excluded.scores,
        reasons = excluded.reasons,
        answeredCount = excluded.answeredCount,
        updatedAt = excluded.updatedAt
    `,
    )
    .run(
      input.taskId,
      input.url,
      JSON.stringify(input.scores),
      JSON.stringify(input.reasons),
      input.answeredCount,
      timestamp,
      timestamp,
    );
  return getManualDraft(input.taskId, input.url)!;
}

export function deleteManualDraft(taskId: string, url: string) {
  getDb().prepare("DELETE FROM manual_drafts WHERE taskId = ? AND url = ?").run(taskId, url);
}

export function deleteManualDraftsForTask(taskId: string) {
  getDb().prepare("DELETE FROM manual_drafts WHERE taskId = ?").run(taskId);
}

export function getQualityReviewDraft(taskId: string, url: string): QualityReviewDraftRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM quality_review_drafts WHERE taskId = ? AND url = ?")
    .get(taskId, url) as Record<string, unknown> | undefined;
  return row ? rowToQualityReviewDraft(row) : null;
}

export function listQualityReviewDrafts(taskId: string): QualityReviewDraftRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM quality_review_drafts WHERE taskId = ? ORDER BY updatedAt ASC")
    .all(taskId) as Record<string, unknown>[];
  return rows.map(rowToQualityReviewDraft);
}

export function saveQualityReviewDraft(input: { taskId: string; url: string; scores: number[]; reasons: string[]; answeredCount: number }) {
  const timestamp = now();
  getDb()
    .prepare(
      `
      INSERT INTO quality_review_drafts (taskId, url, scores, reasons, answeredCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(taskId, url) DO UPDATE SET
        scores = excluded.scores,
        reasons = excluded.reasons,
        answeredCount = excluded.answeredCount,
        updatedAt = excluded.updatedAt
    `,
    )
    .run(
      input.taskId,
      input.url,
      JSON.stringify(input.scores),
      JSON.stringify(input.reasons),
      input.answeredCount,
      timestamp,
      timestamp,
    );
  return getQualityReviewDraft(input.taskId, input.url)!;
}

export function deleteQualityReviewDraft(taskId: string, url: string) {
  getDb().prepare("DELETE FROM quality_review_drafts WHERE taskId = ? AND url = ?").run(taskId, url);
}

export function deleteQualityReviewDraftsForTask(taskId: string) {
  getDb().prepare("DELETE FROM quality_review_drafts WHERE taskId = ?").run(taskId);
}

export function migrateManualDraftsAfterRubricRemoval(taskId: string, removedIndexes: number[], nextRubricCount: number) {
  if (!removedIndexes.length) return;
  const removed = new Set(removedIndexes);
  for (const draft of listManualDrafts(taskId)) {
    const nextScores = draft.scores.filter((_score, index) => !removed.has(index));
    const nextReasons = draft.reasons.filter((_reason, index) => !removed.has(index));
    saveManualDraft({
      taskId,
      url: draft.url,
      scores: nextScores,
      reasons: nextReasons,
      answeredCount: firstUnansweredIndex(nextReasons, nextRubricCount),
    });
  }
}

export function updateResultScoresAndReasons(resultId: string, scores: number[], reasons: string[]) {
  getDb()
    .prepare(
      `
      UPDATE results
      SET scores = ?, reasons = ?
      WHERE id = ?
    `,
    )
    .run(JSON.stringify(scores), JSON.stringify(reasons), resultId);
}

export function deleteTaskLogsForTask(taskId: string) {
  getDb().prepare("DELETE FROM task_logs WHERE taskId = ?").run(taskId);
}

export function deleteQualityReviewResultsForTask(taskId: string) {
  getDb().prepare("DELETE FROM quality_review_results WHERE taskId = ?").run(taskId);
}

export function resetQualityReviewProgress(taskId: string) {
  const task = getTask(taskId);
  if (!task) throw new Error("Task not found");
  const db = getDb();
  const transaction = db.transaction(() => {
    deleteQualityReviewDraftsForTask(taskId);
    deleteQualityReviewResultsForTask(taskId);
  });
  transaction();
  return getTask(taskId)!;
}

export function saveQualityReviewResult(result: Omit<QualityReviewResult, "createdAt" | "updatedAt">) {
  const timestamp = now();
  getDb()
    .prepare(
      `
      INSERT INTO quality_review_results (taskId, url, scores, reasons, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(taskId, url) DO UPDATE SET
        scores = excluded.scores,
        reasons = excluded.reasons,
        updatedAt = excluded.updatedAt
    `,
    )
    .run(result.taskId, result.url, JSON.stringify(result.scores), JSON.stringify(result.reasons), timestamp, timestamp);
  return listQualityReviewResults(result.taskId).find((item) => item.url === result.url)!;
}

export function listQualityReviewResults(taskId: string): QualityReviewResult[] {
  const rows = getDb()
    .prepare("SELECT * FROM quality_review_results WHERE taskId = ? ORDER BY updatedAt ASC")
    .all(taskId) as Record<string, unknown>[];
  return rows.map(rowToQualityReviewResult);
}

export function clearQualityReviewForTask(taskId: string) {
  const task = getTask(taskId);
  if (!task) throw new Error("Task not found");
  const db = getDb();
  const transaction = db.transaction(() => {
    deleteQualityReviewDraftsForTask(taskId);
    deleteQualityReviewResultsForTask(taskId);
    updateTask(taskId, {
      qualityReviewEnabled: false,
      qualityReviewScoreText: "",
      qualityReviewReasonText: "",
      qualityReviewScoreMatrix: [],
      qualityReviewReasonMatrix: [],
    });
  });
  transaction();
}

export function deleteTask(taskId: string) {
  const db = getDb();
  const transaction = db.transaction(() => {
    deleteManualDraftsForTask(taskId);
    deleteQualityReviewDraftsForTask(taskId);
    deleteResultsForTask(taskId);
    deleteQualityReviewResultsForTask(taskId);
    deleteTaskLogsForTask(taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  });
  transaction();
}

export function saveTaskLog(input: { taskId: string; message: string; extra?: unknown }): TaskLog {
  const id = crypto.randomUUID();
  const createdAt = now();
  getDb()
    .prepare(`
      INSERT INTO task_logs (id, taskId, message, extra, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      id,
      input.taskId,
      input.message,
      input.extra === undefined ? null : JSON.stringify(input.extra),
      createdAt,
    );
  return { id, taskId: input.taskId, message: input.message, extra: input.extra, createdAt };
}

export function listTaskLogs(taskId: string): TaskLog[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_logs WHERE taskId = ? ORDER BY createdAt ASC LIMIT 200")
    .all(taskId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    taskId: String(row.taskId),
    message: String(row.message),
    extra: parseJson(String(row.extra ?? ""), undefined),
    createdAt: String(row.createdAt),
  }));
}

export function saveResult(result: Omit<ScoreResult, "id" | "createdAt">): ScoreResult {
  const id = crypto.randomUUID();
  const createdAt = now();
  getDb()
    .prepare(`
      INSERT INTO results (id, taskId, url, scores, reasons, evidence, rawResponse, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      result.taskId,
      result.url,
      JSON.stringify(result.scores),
      JSON.stringify(result.reasons),
      JSON.stringify(result.evidence),
      result.rawResponse,
      createdAt,
    );
  return { ...result, id, createdAt };
}

export function listResults(taskId: string): ScoreResult[] {
  const rows = getDb()
    .prepare("SELECT * FROM results WHERE taskId = ? ORDER BY createdAt ASC")
    .all(taskId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    taskId: String(row.taskId),
    url: String(row.url),
    scores: parseJson<number[]>(String(row.scores), []),
    reasons: parseJson<string[]>(String(row.reasons), []),
    evidence: parseJson<PageEvidence>(String(row.evidence), makeEmptyEvidence(String(row.url))),
    rawResponse: String(row.rawResponse),
    createdAt: String(row.createdAt),
  }));
}

export function makeEmptyEvidence(url: string): PageEvidence {
  return {
    url,
    finalUrl: url,
    title: "",
    htmlSample: "",
    visibleText: "",
    requirements: { ids: [], classes: [] },
    requiredElements: [],
    importantElements: [],
    controls: [],
    layout: {},
    visual: {},
    technology: {},
    responsive: {},
    motion: {},
    interactions: [],
    rubricEvidence: [],
    errors: ["Stored evidence could not be parsed."],
  };
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    name: String(row.name),
    prompt: String(row.prompt),
    urls: parseJson<string[]>(String(row.urls), []),
    rubrics: parseJson(String(row.rubrics), []),
    rubricsSource: ["user", "generated", "none"].includes(String(row.rubricsSource))
      ? (String(row.rubricsSource) as Task["rubricsSource"])
      : "generated",
    rubricsModified: Number(row.rubricsModified ?? 0) === 1,
    qualityMode: Number(row.qualityMode ?? 0) === 1,
    qualityScoreText: String(row.qualityScoreText ?? ""),
    qualityMatrix: parseJson<number[][]>(String(row.qualityMatrix ?? "[]"), []),
    qualityReviewEnabled: Number(row.qualityReviewEnabled ?? 0) === 1,
    qualityReviewScoreText: String(row.qualityReviewScoreText ?? ""),
    qualityReviewReasonText: String(row.qualityReviewReasonText ?? ""),
    qualityReviewScoreMatrix: parseJson<number[][]>(String(row.qualityReviewScoreMatrix ?? "[]"), []),
    qualityReviewReasonMatrix: parseJson<string[][]>(String(row.qualityReviewReasonMatrix ?? "[]"), []),
    mode: ["auto", "manual"].includes(String(row.mode)) ? (String(row.mode) as TaskMode) : "manual",
    status: String(row.status) as TaskStatus,
    error: row.error ? String(row.error) : undefined,
    resultCount: Number(row.resultCount ?? 0),
    qualityReviewResultCount: Number(row.qualityReviewResultCount ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function rowToManualDraft(row: Record<string, unknown>): ManualDraftRecord {
  return {
    taskId: String(row.taskId),
    url: String(row.url),
    scores: parseJson<number[]>(String(row.scores), []),
    reasons: parseJson<string[]>(String(row.reasons), []),
    answeredCount: Number(row.answeredCount ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function rowToQualityReviewDraft(row: Record<string, unknown>): QualityReviewDraftRecord {
  return {
    taskId: String(row.taskId),
    url: String(row.url),
    scores: parseJson<number[]>(String(row.scores), []),
    reasons: parseJson<string[]>(String(row.reasons), []),
    answeredCount: Number(row.answeredCount ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function rowToQualityReviewResult(row: Record<string, unknown>): QualityReviewResult {
  return {
    taskId: String(row.taskId),
    url: String(row.url),
    scores: parseJson<number[]>(String(row.scores), []),
    reasons: parseJson<string[]>(String(row.reasons), []),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function firstUnansweredIndex(reasons: string[], count: number) {
  const index = reasons.findIndex((reason, reasonIndex) => reasonIndex < count && !reason.trim());
  return index >= 0 ? index : count;
}
