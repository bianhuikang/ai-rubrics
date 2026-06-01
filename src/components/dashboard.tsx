"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RUBRIC_PROMPT, DEFAULT_SCORING_PROMPT } from "@/lib/default-prompts";
import type { QualityReviewResult, Rubric, ScoreResult, Settings, SettingsConfig, Task, TaskLog, TaskStatus } from "@/lib/types";

const emptySettings: Settings = {
  apiFormat: "openai-chat-completions",
  endpointUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.2,
  extraRequestParams: "{}",
  rubricPrompt: "",
  scoringPrompt: "",
};

type Notice = {
  kind: "info" | "error" | "success";
  text: string;
};

type SettingsResponse = {
  settings: Settings;
  configs: SettingsConfig[];
  activeConfigId: string;
  manualCheckMode: boolean;
};

type ParsedCaseRow = {
  id: string;
  prompt: string;
  urlsText: string;
  rubricsText: string;
  qualityReviewScoreText: string;
  qualityReviewReasonText: string;
};

type BatchCreateResponse = {
  createdTasks: Task[];
  duplicateIds: string[];
  errors: Array<{ id: string; message: string }>;
};

type QualityMismatch = {
  url: string;
  urlIndex: number;
  rubricIndexes: number[];
};

const runningStatuses: TaskStatus[] = ["queued", "generating-rubrics", "scoring"];

export function Dashboard() {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [settingsConfigs, setSettingsConfigs] = useState<SettingsConfig[]>([]);
  const [activeConfigId, setActiveConfigId] = useState("");
  const [activeConfigName, setActiveConfigName] = useState("默认配置");
  const [editingNewConfig, setEditingNewConfig] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [qualityReviewResults, setQualityReviewResults] = useState<QualityReviewResult[]>([]);
  const [taskLogs, setTaskLogs] = useState<TaskLog[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [testResult, setTestResult] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [rubricsReviewOpen, setRubricsReviewOpen] = useState(false);
  const [qualityLocatorOpen, setQualityLocatorOpen] = useState(false);
  const [qualityScoreText, setQualityScoreText] = useState("");
  const [qualityReviewScoreText, setQualityReviewScoreText] = useState("");
  const [qualityReviewReasonText, setQualityReviewReasonText] = useState("");
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [rubricsText, setRubricsText] = useState("");
  const rubricNormalizationInFlightRef = useRef<string | null>(null);
  const settingsOpenRef = useRef(false);
  const manualMode = true;

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (activeTask) {
      void loadResults(activeTask.id);
      void loadQualityReviewResults(activeTask.id);
      void loadTaskLogs(activeTask.id);
    } else {
      setResults([]);
      setQualityReviewResults([]);
      setTaskLogs([]);
    }
  }, [activeTask?.id]);

  useEffect(() => {
    setQualityScoreText(activeTask?.qualityScoreText ?? "");
  }, [activeTask?.id, activeTask?.qualityScoreText]);

  useEffect(() => {
    const shouldPoll = runningTaskIds.size > 0;
    if (!shouldPoll) return;

    const timer = window.setInterval(() => {
      void refreshAll({ keepSelection: true });
      if (activeTask) {
        void loadResults(activeTask.id);
        void loadQualityReviewResults(activeTask.id);
        void loadTaskLogs(activeTask.id);
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [activeTask?.id, runningTaskIds]);

  useEffect(() => {
    if (!activeTask || activeTask.mode !== "manual" || activeTask.status === "scored" || activeTask.status === "error") return;

    const timer = window.setInterval(() => {
      void refreshAll({ keepSelection: true });
      void loadResults(activeTask.id);
      void loadQualityReviewResults(activeTask.id);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [activeTask?.id, activeTask?.mode, activeTask?.status]);

  useEffect(() => {
    if (!activeTask) return;

    const normalizedRubrics = normalizeRubricsIfNeeded(activeTask.rubrics);
    if (!normalizedRubrics) return;

    const taskIdToNormalize = activeTask.id;
    if (rubricNormalizationInFlightRef.current === taskIdToNormalize) return;
    rubricNormalizationInFlightRef.current = taskIdToNormalize;

    void (async () => {
      try {
                        const response = await fetch(`/api/tasks/${taskIdToNormalize}/rubrics`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            rubrics: normalizedRubrics,
                            removedIndexes: [],
                            preserveRubricsModified: true,
                            preserveQualityReview: true,
                          }),
                        });
        const data = (await response.json()) as { task?: Task; results?: ScoreResult[]; error?: string };
        if (!response.ok || !data.task || !data.results) throw new Error(data.error || "Rubrics 保存失败");
        setTasks((current) => current.map((task) => (task.id === data.task?.id ? data.task! : task)));
        setActiveTask((current) => (current?.id === data.task?.id ? data.task! : current));
        setResults(data.results);
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        if (rubricNormalizationInFlightRef.current === taskIdToNormalize) {
          rubricNormalizationInFlightRef.current = null;
        }
      }
    })();
  }, [activeTask?.id, activeTask?.rubrics]);

  useEffect(() => {
    if (!activeTask) return;

    const refreshActiveTaskResults = () => {
      void refreshAll({ keepSelection: true });
      void loadResults(activeTask.id);
      void loadQualityReviewResults(activeTask.id);
    };

    const handleFocus = () => {
      refreshActiveTaskResults();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshActiveTaskResults();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeTask?.id]);

  const activeTotals = useMemo(() => {
    return results.map((result) => ({
      url: result.url,
      total: result.scores.reduce((sum, score) => sum + score, 0),
      max: activeTask?.rubrics.length ?? result.scores.length,
    }));
  }, [activeTask?.rubrics.length, results]);

  const activeQualityTargets = useMemo(() => {
    if (!activeTask || !activeTask.qualityMode) return [];
    return findQualityMismatches(activeTask, results, activeTask.qualityMatrix);
  }, [activeTask, results]);

  const taskStats = useMemo(() => {
    const completed = tasks.filter((task) => task.status === "scored").length;
    return {
      total: tasks.length,
      completed,
      unfinished: tasks.length - completed,
    };
  }, [tasks]);
  const filteredTasks = useMemo(() => {
    const keyword = taskSearch.trim().toLowerCase();
    if (!keyword) return tasks;
    return tasks.filter((task) => task.id.toLowerCase().includes(keyword));
  }, [taskSearch, tasks]);

  function isTaskDeletable(task: Task) {
    return !runningTaskIds.has(task.id) && !runningStatuses.includes(task.status);
  }

  const deletableFilteredTasks = useMemo(
    () => filteredTasks.filter((task) => isTaskDeletable(task)),
    [filteredTasks, runningTaskIds],
  );

  const selectedDeletableTasks = useMemo(
    () => filteredTasks.filter((task) => selectedTaskIds.has(task.id) && isTaskDeletable(task)),
    [filteredTasks, selectedTaskIds, runningTaskIds],
  );

  const allFilteredDeletableSelected =
    deletableFilteredTasks.length > 0 && deletableFilteredTasks.every((task) => selectedTaskIds.has(task.id));

  async function loadSettings() {
    const settingsResponse = await fetch("/api/settings");
    applySettingsResponse((await settingsResponse.json()) as SettingsResponse);
  }

  async function refreshTasks(options: { keepSelection?: boolean } = {}) {
    const tasksResponse = await fetch("/api/tasks");
    const taskData = (await tasksResponse.json()) as { tasks: Task[] };
    setTasks(taskData.tasks);
    setActiveTask((current) => {
      if (options.keepSelection && current) {
        return taskData.tasks.find((task) => task.id === current.id) ?? current;
      }
      return current ? taskData.tasks.find((task) => task.id === current.id) ?? current : taskData.tasks[0] ?? null;
    });
  }

  async function refreshAll(options: { keepSelection?: boolean; includeSettings?: boolean } = {}) {
    const includeSettings = options.includeSettings ?? !settingsOpenRef.current;
    if (includeSettings) {
      await Promise.all([loadSettings(), refreshTasks(options)]);
      return;
    }
    await refreshTasks(options);
  }

  function applySettingsResponse(data: SettingsResponse) {
    setSettings({ ...emptySettings, ...data.settings, extraRequestParams: data.settings.extraRequestParams ?? "{}" });
    setSettingsConfigs(data.configs);
    setActiveConfigId(data.activeConfigId);
    setActiveConfigName(data.configs.find((config) => config.id === data.activeConfigId)?.name || "默认配置");
    setEditingNewConfig(false);
  }

  async function loadResults(id: string) {
    const response = await fetch(`/api/tasks/${id}/results`);
    if (!response.ok) return;
    const data = (await response.json()) as { results: ScoreResult[] };
    setResults(data.results);
  }

  async function loadQualityReviewResults(id: string) {
    const response = await fetch(`/api/tasks/${id}/quality-review-results`);
    if (!response.ok) return;
    const data = (await response.json()) as { results: QualityReviewResult[] };
    setQualityReviewResults(data.results);
  }

  async function loadTaskLogs(id: string) {
    const response = await fetch(`/api/tasks/${id}/logs`);
    if (!response.ok) return;
    const data = (await response.json()) as { logs: TaskLog[] };
    setTaskLogs(data.logs);
  }

  async function saveSettings() {
    if (!activeConfigName.trim()) {
      setNotice({ kind: "error", text: "请填写配置名称。" });
      return;
    }
    await run("settings", "配置已保存。", async () => {
      const response = editingNewConfig
        ? await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: activeConfigName, settings }),
          })
        : await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...settings, id: activeConfigId, name: activeConfigName }),
      });
      if (!response.ok) throw new Error(await response.text());
      applySettingsResponse((await response.json()) as SettingsResponse);
    });
  }

  async function switchSettingsConfig(id: string) {
    if (id === activeConfigId && !editingNewConfig) return;
    await run("settings-switch", "配置已切换。", async () => {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error(await response.text());
      applySettingsResponse((await response.json()) as SettingsResponse);
    });
  }

  function startNewSettingsConfig() {
    setEditingNewConfig(true);
    setActiveConfigId("");
    setActiveConfigName(`配置 ${settingsConfigs.length + 1}`);
    setSettings({
      ...emptySettings,
      rubricPrompt: DEFAULT_RUBRIC_PROMPT,
      scoringPrompt: DEFAULT_SCORING_PROMPT,
    });
    setTestResult(null);
  }

  async function deleteActiveSettingsConfig() {
    if (!activeConfigId) return;
    await run("settings-delete", "配置已删除。", async () => {
      const response = await fetch(`/api/settings?id=${encodeURIComponent(activeConfigId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await response.text());
      applySettingsResponse((await response.json()) as SettingsResponse);
    });
  }

  async function testSettings() {
    await run("settings-test", "测试完成。", async () => {
      setTestResult({ kind: "info", text: "测试中..." });
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = (await response.json()) as { ok: boolean; response?: string; error?: string };
      if (!response.ok || !data.ok) {
        setTestResult({ kind: "error", text: data.error || "测试失败。" });
        throw new Error(data.error || "测试失败。");
      }
      setTestResult({ kind: "success", text: data.response ? `接口可请求：${data.response}` : "接口可请求。" });
    });
  }

  async function createTask() {
    const id = taskId.trim();
    const promptText = prompt.trim();
    let urls: string[];
    let rubrics: Rubric[];
    let qualityReviewPayload: {
      qualityReviewEnabled?: true;
      qualityReviewScoreText?: string;
      qualityReviewReasonText?: string;
      qualityReviewScoreMatrix?: number[][];
      qualityReviewReasonMatrix?: string[][];
    } = {};
    try {
      urls = parseUrls(urlsText);
      rubrics = parseRubricsInput(rubricsText);
      if (!promptText && !rubrics.length) {
        throw new Error("需要自动生成 Rubrics 时请填写 Prompt；手填 Rubrics 时可以不填。");
      }
      qualityReviewPayload = parseQualityReviewInputs({
        urls,
        rubrics,
        scoreText: qualityReviewScoreText,
        reasonText: qualityReviewReasonText,
      });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      return;
    }

    await run("create", "任务已创建，已自动开始执行。", async () => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: id || undefined,
          prompt: promptText,
          urls,
          rubrics,
          mode: manualMode ? "manual" : "auto",
          ...qualityReviewPayload,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const task = (await response.json()) as Task;
      setTasks((current) => [task, ...current]);
      setActiveTask(task);
      setResults([]);
      setQualityReviewResults([]);
      setTaskLogs([]);
      void runTask(task.id);
    });
  }

  async function parseClipboardCase() {
    try {
      const text = await navigator.clipboard.readText();
      const rowChunks = splitCaseRows(text);

      if (rowChunks.length > 1) {
        const parsedRows = parseCaseRows(text);
        if (!parsedRows.length) {
          applyPartialPastedCase(parseCaseRowPartial(rowChunks[0] ?? text));
          return;
        }
        await createParsedCaseTasks(parsedRows);
        return;
      }

      applyPartialPastedCase(parseCaseRowPartial(rowChunks[0] ?? text));
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  function applyPartialPastedCase(parsed: ParsedCaseRow) {
    setTaskId(parsed.id);
    setPrompt(parsed.prompt);
    setUrlsText(parsed.urlsText);
    setRubricsText(parsed.rubricsText);
    setQualityReviewScoreText(parsed.qualityReviewScoreText);
    setQualityReviewReasonText(parsed.qualityReviewReasonText);
    if (Object.values(parsed).some(Boolean)) {
      setNotice({ kind: "success", text: "已解析到表单。" });
    }
  }

  async function createParsedCaseTasks(parsedRows: ParsedCaseRow[]) {
    try {
      setBusy("batch-create");
      const tasksToCreate: Array<{
        id: string;
        prompt: string;
        urls: string[];
        rubrics: Rubric[];
        mode: "auto" | "manual";
        skipIfExists: true;
        qualityReviewEnabled?: true;
        qualityReviewScoreText?: string;
        qualityReviewReasonText?: string;
        qualityReviewScoreMatrix?: number[][];
        qualityReviewReasonMatrix?: string[][];
      }> = [];
      const localErrors: Array<{ id: string; message: string }> = [];
      let missingIdCount = 0;

      for (const parsed of parsedRows) {
        const id = parsed.id.trim();
        if (!id) {
          missingIdCount += 1;
          continue;
        }

        try {
          const urls = parseUrls(parsed.urlsText);
          const rubrics = parseRubricsInput(parsed.rubricsText);
          const qualityReviewPayload = parseQualityReviewInputs({
            urls,
            rubrics,
            scoreText: parsed.qualityReviewScoreText,
            reasonText: parsed.qualityReviewReasonText,
          });
          tasksToCreate.push({
            id,
            prompt: parsed.prompt,
            urls,
            rubrics,
            mode: manualMode ? "manual" : "auto",
            skipIfExists: true,
            ...qualityReviewPayload,
          });
        } catch (error) {
          localErrors.push({
            id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!tasksToCreate.length) {
        const invalidCount = localErrors.length + missingIdCount;
        setNotice({ kind: "info", text: `没有可创建的任务，已跳过 ${invalidCount} 条。` });
        return;
      }

      setNotice({ kind: "info", text: `正在批量创建 ${tasksToCreate.length} 个任务...` });

      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: tasksToCreate }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as BatchCreateResponse;
      const createdTasks = data.createdTasks;
      const errors = [...localErrors, ...data.errors];

      if (createdTasks.length) {
        setTasks((current) => [...createdTasks, ...current]);
        setActiveTask(createdTasks[0]);
        setResults([]);
        setTaskLogs([]);
        createdTasks.forEach((task) => void runTask(task.id));
      }

      const alertSections: string[] = [];
      if (data.duplicateIds.length) {
        alertSections.push(`这些任务重复未创建：\n${data.duplicateIds.join("\n")}`);
      }
      if (createdTasks.length) {
        alertSections.push(`这些任务创建成功：\n${createdTasks.map((task) => task.id).join("\n")}`);
      }
      if (missingIdCount) {
        alertSections.push(`有 ${missingIdCount} 条缺少任务 ID，未创建。`);
      }
      if (errors.length) {
        alertSections.push(
          `这些任务创建失败：\n${errors.map((item) => `${item.id || "(无ID)"}: ${item.message}`).join("\n")}`,
        );
      }
      if (alertSections.length) {
        window.alert(alertSections.join("\n\n"));
      }

      const summaryParts = [`已创建 ${createdTasks.length} 个任务`];
      if (data.duplicateIds.length) summaryParts.push(`重复未创建 ${data.duplicateIds.length} 个`);
      if (missingIdCount) summaryParts.push(`缺少ID ${missingIdCount} 个`);
      if (errors.length) summaryParts.push(`失败 ${errors.length} 个`);

      const hasNonCreated = data.duplicateIds.length > 0 || missingIdCount > 0 || errors.length > 0;

      if (errors.length) {
        setNotice({ kind: createdTasks.length ? "info" : "error", text: `${summaryParts.join("，")}。` });
      } else {
        setNotice({ kind: hasNonCreated ? "info" : "success", text: `${summaryParts.join("，")}。` });
      }
    } finally {
      setBusy(null);
    }
  }

  async function runTask(id: string) {
    setRunningTaskIds((current) => new Set(current).add(id));
    try {
      const response = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { task: Task; results: ScoreResult[] };
      setTasks((current) => current.map((task) => (task.id === data.task.id ? data.task : task)));
      setActiveTask((current) => (current?.id === data.task.id ? data.task : current));
      setResults(data.results);
      setNotice({ kind: "success", text: `任务 ${id} 已完成。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      await refreshAll({ keepSelection: true });
    } finally {
      setRunningTaskIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function deleteTaskById(task: Task) {
    if (!isTaskDeletable(task)) return;
    if (!window.confirm(`确认删除任务 ${task.id} 吗？相关结果、日志和手工草稿都会一起删除。`)) return;
    await deleteTasksByIds([task]);
  }

  function toggleTaskSelection(task: Task) {
    if (!isTaskDeletable(task)) return;
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      return next;
    });
  }

  function toggleSelectAllFilteredTasks() {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (allFilteredDeletableSelected) {
        for (const task of deletableFilteredTasks) next.delete(task.id);
      } else {
        for (const task of deletableFilteredTasks) next.add(task.id);
      }
      return next;
    });
  }

  async function deleteSelectedTasks() {
    const tasksToDelete = selectedDeletableTasks;
    if (!tasksToDelete.length) return;
    if (
      !window.confirm(
        `确认删除已选中的 ${tasksToDelete.length} 个任务吗？相关结果、日志和手工草稿都会一起删除。`,
      )
    ) {
      return;
    }
    await deleteTasksByIds(tasksToDelete);
  }

  async function deleteTasksByIds(tasksToDelete: Task[]) {
    if (!tasksToDelete.length) return;

    const deletedIds = new Set<string>();
    const failed: string[] = [];

    await run("delete-tasks", `已删除 ${tasksToDelete.length} 个任务。`, async () => {
      await Promise.all(
        tasksToDelete.map(async (task) => {
          const response = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
          if (!response.ok) {
            failed.push(task.id);
            return;
          }
          deletedIds.add(task.id);
        }),
      );

      if (!deletedIds.size) {
        throw new Error(failed.length ? `删除失败：${failed.join("、")}` : "没有任务被删除。");
      }

      applyTasksDeleted(deletedIds);

      if (failed.length) {
        throw new Error(`部分任务删除失败：${failed.join("、")}`);
      }
    });
  }

  function applyTasksDeleted(deletedIds: Set<string>) {
    const activeDeleted = activeTask ? deletedIds.has(activeTask.id) : false;

    setTasks((current) => current.filter((item) => !deletedIds.has(item.id)));
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      for (const id of deletedIds) next.delete(id);
      return next;
    });
    setRunningTaskIds((current) => {
      const next = new Set(current);
      for (const id of deletedIds) next.delete(id);
      return next;
    });

    if (activeDeleted) {
      setActiveTask(null);
      setResults([]);
      setQualityReviewResults([]);
      setTaskLogs([]);
      setRubricsReviewOpen(false);
    }
  }

  async function rerunActiveTask() {
    if (!activeTask) return;
    setNotice({ kind: "info", text: `任务 ${activeTask.id} 已重新开始。` });
    setResults([]);
    setTaskLogs([]);
    void runTask(activeTask.id);
  }

  async function resetActiveQualityReview() {
    if (!activeTask?.qualityReviewEnabled) return;
    if (!window.confirm("??????????????????")) return;
    try {
      const response = await fetch(`/api/tasks/${activeTask.id}/quality-review-results`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { task?: Task; results?: QualityReviewResult[]; error?: string };
      if (!response.ok || !data.task || !data.results) {
        throw new Error(data.error || "??????");
      }
      const nextTask = data.task;
      setTasks((current) => current.map((task) => (task.id === nextTask.id ? nextTask : task)));
      setActiveTask((current) => (current?.id === nextTask.id ? nextTask : current));
      setQualityReviewResults(data.results);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateTaskQualityState(
    taskId: string,
    patch: Pick<Task, "qualityMode" | "qualityScoreText" | "qualityMatrix">,
  ) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(await response.text());
    const updated = (await response.json()) as Task;
    setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
    setActiveTask((current) => (current?.id === updated.id ? updated : current));
    return updated;
  }

  function openQualityLocator() {
    if (!activeTask) return;
    if (activeTask.qualityMode) {
      if (!window.confirm("确认结束当前任务的质检定位吗？红框提示会被清除。")) return;
      void clearQualityLocator();
      return;
    }
    setQualityScoreText(activeTask.qualityScoreText ?? "");
    setQualityLocatorOpen(true);
  }

  async function saveQualityLocator() {
    if (!activeTask) return;
    try {
      const matrix = parseQualityScoreMatrix(qualityScoreText, activeTask);
      const mismatches = findQualityMismatches(activeTask, results, matrix);
      await updateTaskQualityState(activeTask.id, {
        qualityMode: true,
        qualityScoreText,
        qualityMatrix: matrix,
      });
      setQualityLocatorOpen(false);
      setNotice({
        kind: mismatches.length ? "success" : "info",
        text: mismatches.length
          ? `质检定位已保存，找到 ${mismatches.length} 个页面存在不一致。`
          : "质检定位已保存，当前结果和质检分数一致。",
      });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function clearQualityLocator() {
    if (!activeTask) return;
    await updateTaskQualityState(activeTask.id, {
      qualityMode: false,
      qualityScoreText: "",
      qualityMatrix: [],
    });
    setQualityScoreText("");
    setQualityLocatorOpen(false);
    setNotice({ kind: "info", text: "已清除质检定位。" });
  }

  async function run(key: string, success: string, action: () => Promise<void>) {
    try {
      setBusy(key);
      setNotice({ kind: "info", text: "处理中..." });
      await action();
      setNotice({ kind: "success", text: success });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <div className="title-row">
            <h1>AI Rubrics Judge</h1>
            <a className="button-link small-button docs-button" href="/docs" target="_blank" rel="noreferrer">
              使用文档
            </a>
          </div>
    
        </div>
        <div className="topbar-actions">
          {notice ? <div className={`notice ${notice.kind}`}>{notice.text}</div> : null}
          <div className="active-model-chip" title={`${activeConfigName} / ${settings.model || "未设置模型"}`}>
            <span>{activeConfigName}</span>
            <strong>{settings.model || "未设置模型"}</strong>
          </div>
          <button onClick={() => setSettingsOpen(true)}>配置</button>
        </div>
      </header>

      <section className="tri-layout">
        <section className="compact-panel create-panel">
          <div className="panel-header">
            <h2>新建任务</h2>
            <div className="actions">
              <button onClick={parseClipboardCase} disabled={Boolean(busy)}>
                解析剪贴板
              </button>
              <button className="primary" onClick={createTask} disabled={Boolean(busy)}>
                创建
              </button>
            </div>
          </div>
          <label>
            任务 ID
            <input value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="不填自动生成" />
          </label>
          <label>
            Prompt
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={8}
              placeholder="可以不填；需要生成 Rubrics 时必填。"
            />
          </label>
          <label>
            产物 URL 数组
            <textarea value={urlsText} onChange={(event) => setUrlsText(event.target.value)} rows={8} />
          </label>
          <label>
            Rubrics（可选）
            <textarea
              value={rubricsText}
              onChange={(event) => setRubricsText(clearRubricsTextIfHtmlOrReact(event.target.value))}
              rows={8}
              placeholder={"留空则自动生成；手填时一行一条规则。"}
            />
          </label>
          <div className="quality-review-create-section">
            <p className="quality-review-create-title">质检专用</p>

          <label>
            质检评分
            <textarea
              value={qualityReviewScoreText}
              onChange={(event) => setQualityReviewScoreText(event.target.value)}
              rows={6}
              placeholder='支持 JSON，如 [[1,0,1],[0,1,1]]；也支持每行一个页面：1,0,1'
            />
          </label>
          <label>
            质检理由
            <textarea
              value={qualityReviewReasonText}
              onChange={(event) => setQualityReviewReasonText(event.target.value)}
              rows={8}
              placeholder='支持 JSON / 按页面矩阵；也支持平铺格式：第1个页面->第4条rubrics->原因'
            />
          </label>
          <p className="field-hint">质检评分和质检理由必须同时填写，或同时留空。填写时必须同时提供 Rubrics。</p>
          </div>
        </section>

        <section className="compact-panel task-panel">
          <div className="panel-header">
            <div className="task-title-line">
              <h2>任务列表</h2>
              <span>总数 {taskStats.total}</span>
              <span>已完成 {taskStats.completed}</span>
              <span>未完成 {taskStats.unfinished}</span>
            </div>
            <div className="task-header-actions">
              <input
                className="task-search-input"
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                placeholder="搜索任务 ID"
              />
              <button onClick={() => void refreshAll({ keepSelection: true })}>刷新</button>
              <button
                className="danger-button"
                disabled={Boolean(busy) || !selectedDeletableTasks.length}
                onClick={() => void deleteSelectedTasks()}
              >
                删除选中{selectedDeletableTasks.length ? ` (${selectedDeletableTasks.length})` : ""}
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th className="task-select-col">
                    <input
                      type="checkbox"
                      aria-label="全选当前列表可删除任务"
                      checked={allFilteredDeletableSelected}
                      disabled={!deletableFilteredTasks.length}
                      onChange={toggleSelectAllFilteredTasks}
                    />
                  </th>
                  <th>任务 ID</th>
                  <th>状态</th>
                  <th>URL</th>
                  <th>进度</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.length ? (
                  filteredTasks.map((task) => {
                    const progress = taskProgress(task);
                    return (
                      <tr
                        key={task.id}
                        className={[
                          activeTask?.id === task.id ? "active-row" : "",
                          `task-row-${task.status}`,
                          task.qualityReviewEnabled ? "task-row-quality-review" : "",
                          task.rubricsModified ? "task-row-rubrics-modified" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => {
                          setActiveTask(task);
                          void loadResults(task.id);
                        }}
                      >
                        <td className="task-select-col" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`选择任务 ${task.id}`}
                            checked={selectedTaskIds.has(task.id)}
                            disabled={!isTaskDeletable(task)}
                            onChange={() => toggleTaskSelection(task)}
                          />
                        </td>
                        <td>
                          <div className="task-id-cell">
                            <span className="mono">{task.id}</span>
                            {task.qualityReviewEnabled ? <span className="task-tag quality-review-tag">质检</span> : null}
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td>
                          {taskCompletedPageCount(task)}/{task.urls.length}
                        </td>
                        <td>
                          <div className="progress-cell">
                            <div className="progress-track">
                              <span style={{ width: `${progress}%` }} />
                            </div>
                            <small>{progress}%</small>
                          </div>
                        </td>
                        <td>{formatTime(task.updatedAt)}</td>
                        <td>
                          <div className="row-actions">
                            {false ? (
                              <button
                                className="small-button"
                                disabled={runningTaskIds.has(task.id)}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setNotice({ kind: "info", text: `任务 ${task.id} 已重新开始。` });
                                  setActiveTask(task);
                                  setResults([]);
                                  void runTask(task.id);
                                }}
                              >
                                重跑
                              </button>
                            ) : null}
                            <button
                              className="small-button danger-button"
                              disabled={runningTaskIds.has(task.id) || runningStatuses.includes(task.status)}
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteTaskById(task);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={7} className="empty-cell">
                      暂无任务
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="compact-panel result-panel">
          <div className="panel-header">
            <div>
              <h2>结果</h2>
              <p>{activeTask ? activeTask.id : "未选择任务"}</p>
            </div>
            {activeTask ? (
              <div className="actions">
                {!activeTask.qualityReviewEnabled ? (
                  <button
                    className={activeTask.qualityMode ? "quality-locator-active-button" : ""}
                    onClick={openQualityLocator}
                    disabled={!activeTask.rubrics.length}
                  >
                    {activeTask.qualityMode ? "结束质检" : "质检定位"}
                  </button>
                ) : null}
                <button onClick={() => setRubricsReviewOpen(true)} disabled={!activeTask.rubrics.length}>
                  检查 Rubrics
                </button>
                {!activeTask.qualityReviewEnabled ? (
                  <button onClick={rerunActiveTask} disabled={runningTaskIds.has(activeTask.id)}>
                    {"\u91cd\u8dd1"}
                  </button>
                ) : (
                  <button className="danger-button" onClick={resetActiveQualityReview}>
                    {"\u91cd\u7f6e\u8d28\u68c0"}
                  </button>
                )}
              </div>
            ) : null}
          </div>

          {activeTask ? (
          <ResultView
              task={activeTask}
              results={results}
              qualityReviewResults={qualityReviewResults}
              totals={activeTotals}
              logs={taskLogs}
              qualityTargets={activeQualityTargets}
              qualityMatrix={activeTask.qualityMode ? activeTask.qualityMatrix : null}
              onRerunTask={rerunActiveTask}
              onRubricsUpdated={(updatedTask, updatedResults) => {
                setTasks((current) => current.map((task) => (task.id === updatedTask.id ? updatedTask : task)));
                setActiveTask((current) => (current?.id === updatedTask.id ? updatedTask : current));
                setResults(updatedResults);
              }}
              onQualityReviewReset={(updatedTask, updatedResults) => {
                setTasks((current) => current.map((task) => (task.id === updatedTask.id ? updatedTask : task)));
                setActiveTask((current) => (current?.id === updatedTask.id ? updatedTask : current));
                setQualityReviewResults(updatedResults);
              }}
            />
          ) : (
            <p className="muted">从任务列表选择一行查看结果。</p>
          )}
        </section>
      </section>

      {rubricsReviewOpen && activeTask ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRubricsReviewOpen(false)}>
          <section className="rubrics-review-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h2>检查 Rubrics</h2>
                <p>{activeTask.id}</p>
              </div>
              <button onClick={() => setRubricsReviewOpen(false)}>关闭</button>
            </div>
            <div className="rubrics-review-grid">
              <section className="rubrics-review-pane">
                <div className="copy-bar">
                  <span>Prompt</span>
                </div>
                <pre className="review-text">{activeTask.prompt || "未填写 Prompt"}</pre>
              </section>
              <section className="rubrics-review-pane">
                <div className="copy-bar">
                  <span>Rubrics ({activeTask.rubrics.length})</span>
                </div>
                <ul className="review-rubrics">
                  {activeTask.rubrics.map((rubric) => (
                    <li key={rubric.id}>{rubric.description}</li>
                  ))}
                </ul>
              </section>
            </div>
          </section>
        </div>
      ) : null}

      {qualityLocatorOpen && activeTask && !activeTask.qualityReviewEnabled ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setQualityLocatorOpen(false)}>
          <section className="quality-locator-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h2>质检定位</h2>
                <p>{activeTask.id}</p>
              </div>
              <div className="actions">
                <button onClick={clearQualityLocator} type="button">
                  清除
                </button>
                <button onClick={() => setQualityLocatorOpen(false)} type="button">
                  关闭
                </button>
                <button className="primary" onClick={saveQualityLocator} type="button">
                  保存
                </button>
              </div>
            </div>
            <label>
              质检分数数组
              <textarea
                value={qualityScoreText}
                onChange={(event) => setQualityScoreText(event.target.value)}
                rows={10}
                placeholder='例如：[[1,0,1],[1,1,0]]，或每行一页：1,0,1'
              />
            </label>
            <p className="field-hint">
              按当前任务页面顺序和 Rubric 顺序比对，保存后会红框闪烁标出不一致页面，并把对应 Rubric 定位带到手工检查页。
            </p>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div className="settings-title">
                <h2>模型配置</h2>
                <p>不需要生成 Rubrics 时不用配模型。</p>
              </div>
              <div className="actions">
                <button onClick={() => setSettingsOpen(false)}>关闭</button>
                <button onClick={testSettings} disabled={Boolean(busy)}>
                  测试连接
                </button>
                <button className="primary" onClick={saveSettings} disabled={Boolean(busy)}>
                  保存
                </button>
              </div>
            </div>
            <div className="settings-config-bar">
              <div className="settings-tags" role="list" aria-label="模型配置">
                {settingsConfigs.map((config) => (
                  <button
                    key={config.id}
                    className={`config-tag ${!editingNewConfig && config.id === activeConfigId ? "active" : ""}`}
                    onClick={() => void switchSettingsConfig(config.id)}
                    type="button"
                  >
                    {config.name}
                  </button>
                ))}
                <button
                  className={`config-tag add ${editingNewConfig ? "active" : ""}`}
                  onClick={startNewSettingsConfig}
                  type="button"
                >
                  + 新增
                </button>
              </div>
              <label>
                配置名称
                <input value={activeConfigName} onChange={(event) => setActiveConfigName(event.target.value)} />
              </label>
              <div className="settings-config-actions">
                <button onClick={deleteActiveSettingsConfig} disabled={Boolean(busy) || editingNewConfig || settingsConfigs.length <= 1}>
                  删除
                </button>
              </div>
            </div>
            <div className="settings-grid">
              <label>
                API 格式
                <select
                  value={settings.apiFormat}
                  onChange={(event) => setSettings({ ...settings, apiFormat: event.target.value as Settings["apiFormat"] })}
                >
                  <option value="openai-chat-completions">OpenAI Chat Completions 格式</option>
                  <option value="anthropic-messages">Anthropic Messages 格式</option>
                </select>
              </label>
              <label>
                完整接口地址
                <input placeholder="例如: https://api.openai.com/v1/chat/completions" value={settings.endpointUrl} onChange={(event) => setSettings({ ...settings, endpointUrl: event.target.value })} />
              </label>
              <label>
                API Key
                <input type="password" placeholder="例如: sk-... 或 ollama（本地模型可随意填）" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} />
              </label>
              <label>
                Model
                <input placeholder="例如: gpt-4o / qwen-plus / deepseek-r1 / llama3" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
              </label>
              <label>
                Temperature
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={settings.temperature}
                  onChange={(event) => setSettings({ ...settings, temperature: Number(event.target.value) })}
                />
              </label>
              <label>
                额外请求参数 JSON
                <textarea
                  value={settings.extraRequestParams}
                  onChange={(event) => setSettings({ ...settings, extraRequestParams: event.target.value })}
                  rows={5}
                />
              </label>
            </div>
            <label>
              Rubrics 生成提示词
              <textarea
                value={settings.rubricPrompt}
                onChange={(event) => setSettings({ ...settings, rubricPrompt: event.target.value })}
                rows={10}
              />
            </label>
            <label>
              评分提示词
              <textarea
                value={settings.scoringPrompt}
                onChange={(event) => setSettings({ ...settings, scoringPrompt: event.target.value })}
                rows={10}
              />
            </label>
            {testResult ? <div className={`notice ${testResult.kind}`}>{testResult.text}</div> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function ResultView({
  task,
  results,
  qualityReviewResults,
  totals,
  logs,
  qualityTargets,
  qualityMatrix,
  onRerunTask,
  onRubricsUpdated,
  onQualityReviewReset,
}: {
  task: Task;
  results: ScoreResult[];
  qualityReviewResults: QualityReviewResult[];
  totals: Array<{ url: string; total: number; max: number }>;
  logs: TaskLog[];
  qualityTargets: QualityMismatch[];
  qualityMatrix: number[][] | null;
  onRerunTask: () => void;
  onRubricsUpdated: (task: Task, results: ScoreResult[]) => void;
  onQualityReviewReset: (task: Task, results: QualityReviewResult[]) => void;
}) {
  const [rubricDrafts, setRubricDrafts] = useState<string[]>(() => task.rubrics.map((rubric) => stripRubricNumberPrefix(rubric.description)));
  const [rubricBusy, setRubricBusy] = useState<number | null>(null);
  const [rubricListBusy, setRubricListBusy] = useState(false);
  const [rubricDragIndex, setRubricDragIndex] = useState<number | null>(null);
  const [rubricDragOverIndex, setRubricDragOverIndex] = useState<number | null>(null);
  const [rubricError, setRubricError] = useState("");
  const [rubricDirty, setRubricDirty] = useState(false);

  useEffect(() => {
    setRubricDrafts(task.rubrics.map((rubric) => stripRubricNumberPrefix(rubric.description)));
    setRubricError("");
    setRubricDirty(false);
  }, [task.id]);

  useEffect(() => {
    if (rubricDirty) return;
    setRubricDrafts(task.rubrics.map((rubric) => stripRubricNumberPrefix(rubric.description)));
    setRubricError("");
  }, [task.rubrics, rubricDirty]);

  const rubricsCopyText = task.rubrics
    .map((rubric, index) => `${index + 1}. ${stripRubricNumberPrefix(rubric.description)}`)
    .join("\n");
  const orderedResults = task.urls
    .map((url) => results.find((result) => result.url === url))
    .filter((result): result is ScoreResult => Boolean(result));
  const allScoresReady = task.status === "scored" && orderedResults.length >= task.urls.length;
  const scoreCopyText = JSON.stringify(orderedResults.map((result) => result.scores));
  const qualityReviewEnabledForTask = isQualityReviewConfigured(task);
  const manualFailSummaries = task.mode === "manual" ? summarizeManualFailReasons(task, results) : [];
  const manualFailCopyText = manualFailSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const qualityReviewFailSummaries =
    task.mode === "manual" && qualityReviewEnabledForTask ? summarizeQualityReviewReviewerReasons(task, qualityReviewResults) : [];
  const qualityReviewFailCopyText = qualityReviewFailSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const qualityTargetByUrl = useMemo(() => {
    return new Map(qualityTargets.map((target) => [target.url, target]));
  }, [qualityTargets]);

  async function persistRubrics(
    nextDescriptions: string[],
    options: { removedIndexes?: number[]; permutation?: number[]; sourceRubrics?: Rubric[] } = {},
  ) {
    const sourceRubrics = options.sourceRubrics ?? task.rubrics;
    const rubrics = nextDescriptions.map((description, index) => ({
      id: `R${index + 1}`,
      name: sourceRubrics[index]?.name || `规则 ${index + 1}`,
      description: stripRubricNumberPrefix(description),
      evidenceHints: sourceRubrics[index]?.evidenceHints || [],
    }));
    const response = await fetch(`/api/tasks/${task.id}/rubrics`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rubrics,
        removedIndexes: options.removedIndexes ?? [],
        permutation: options.permutation,
      }),
    });
    const data = (await response.json()) as { task?: Task; results?: ScoreResult[]; error?: string };
    if (!response.ok || !data.task || !data.results) throw new Error(data.error || "Rubrics 保存失败");
    onRubricsUpdated(data.task, data.results);
    setRubricDrafts(data.task.rubrics.map((rubric) => stripRubricNumberPrefix(rubric.description)));
    setRubricDirty(false);
    setRubricError("");
  }

  async function saveRubric(index: number) {
    const value = stripRubricNumberPrefix(rubricDrafts[index] ?? "");
    if (!value) {
      setRubricError("Rubric 不能为空。");
      return;
    }
    try {
      setRubricBusy(index);
      setRubricError("");
      await persistRubrics(rubricDrafts);
    } catch (error) {
      setRubricError(error instanceof Error ? error.message : String(error));
    } finally {
      setRubricBusy(null);
    }
  }

  async function deleteRubric(index: number) {
    // if (task.rubrics.length <= 1) {
    //   setRubricError("至少保留 1 条 Rubric。");
    //   return;
    // }
    if (!window.confirm(`确认删除第 ${index + 1} 条 Rubric？对应打分和汇总也会同步删除。`)) return;
    try {
      setRubricBusy(index);
      setRubricError("");
      await persistRubrics(
        rubricDrafts.filter((_item, itemIndex) => itemIndex !== index),
        { removedIndexes: [index] },
      );
    } catch (error) {
      setRubricError(error instanceof Error ? error.message : String(error));
    } finally {
      setRubricBusy(null);
    }
  }

  async function addRubric() {
    try {
      setRubricListBusy(true);
      setRubricError("");
      await persistRubrics([...rubricDrafts, "新规则"]);
    } catch (error) {
      setRubricError(error instanceof Error ? error.message : String(error));
    } finally {
      setRubricListBusy(false);
    }
  }

  async function reorderRubrics(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const reorderedDrafts = reorderList(rubricDrafts, fromIndex, toIndex);
    const reorderedRubrics = reorderList(task.rubrics, fromIndex, toIndex);
    const permutation = buildRubricPermutation(fromIndex, toIndex, task.rubrics.length);
    try {
      setRubricListBusy(true);
      setRubricError("");
      setRubricDrafts(reorderedDrafts);
      setRubricDirty(false);
      await persistRubrics(reorderedDrafts, { permutation, sourceRubrics: reorderedRubrics });
    } catch (error) {
      setRubricDrafts(task.rubrics.map((rubric) => stripRubricNumberPrefix(rubric.description)));
      setRubricError(error instanceof Error ? error.message : String(error));
    } finally {
      setRubricListBusy(false);
      setRubricDragIndex(null);
      setRubricDragOverIndex(null);
    }
  }

  function renderRubricSection() {
    return (
      <section className="rubric-section">
        <div className="copy-bar">
          <div className="rubric-copy-with-warning">
            <button className="small-button" onClick={() => void copyText(rubricsCopyText)}>
              复制 Rubrics
            </button>
            <button className="small-button" onClick={() => void addRubric()} disabled={rubricBusy !== null || rubricListBusy}>
              新增 Rubrics
            </button>
            <strong>修改后立即应用，请刷新检查页面</strong>
          </div>
          <span>Rubrics ({task.rubrics.length})</span>
        </div>
        <ol className="rubric-list editable-rubric-list">
          {task.rubrics.map((rubric, index) => (
            <li
              key={`${rubric.id}-${index}`}
              className={[
                rubricDragIndex === index ? "rubric-row-dragging" : "",
                rubricDragOverIndex === index && rubricDragIndex !== index ? "rubric-row-drag-over" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onDragOver={(event) => {
                event.preventDefault();
                if (rubricDragIndex === null || rubricDragIndex === index) return;
                setRubricDragOverIndex(index);
              }}
              onDragLeave={() => {
                if (rubricDragOverIndex === index) setRubricDragOverIndex(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (rubricDragIndex === null) return;
                void reorderRubrics(rubricDragIndex, index);
              }}
            >
              <button
                type="button"
                className="rubric-drag-handle"
                draggable={!rubricListBusy && rubricBusy === null}
                aria-label={`拖动调整第 ${index + 1} 条 Rubric 顺序`}
                title="拖动调整顺序"
                disabled={rubricListBusy || rubricBusy !== null}
                onDragStart={() => setRubricDragIndex(index)}
                onDragEnd={() => {
                  setRubricDragIndex(null);
                  setRubricDragOverIndex(null);
                }}
              >
                ⋮⋮
              </button>
              <span className="rubric-index-label">{index + 1}.</span>
              <input
                value={rubricDrafts[index] ?? stripRubricNumberPrefix(rubric.description)}
                onChange={(event) =>
                  {
                    setRubricDirty(true);
                    setRubricDrafts((current) => current.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)));
                  }
                }
              />
              <div className="rubric-edit-actions">
                <button className="small-button" onClick={() => void saveRubric(index)} disabled={rubricBusy !== null || rubricListBusy}>
                  保存
                </button>
                <button className="small-button danger-button" onClick={() => void deleteRubric(index)} disabled={rubricBusy !== null || rubricListBusy}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ol>
        {rubricError ? <p className="rubric-edit-error">{rubricError}</p> : null}
      </section>
    );
  }

  if (task.status === "error") {
    return (
      <div className="results-wrap">
        <ProcessPanel task={task} logs={logs} />
        <p className="error-text">{task.error || "任务执行失败。"}</p>
      </div>
    );
  }

  if (task.mode === "manual" && task.rubrics.length > 0) {
    if (qualityReviewEnabledForTask) {
      return (
        <div className="results-wrap">
          <QualityReviewTaskResultSection
            task={task}
            results={qualityReviewResults}
            failSummaries={qualityReviewFailSummaries}
            failCopyText={qualityReviewFailCopyText}
            onReset={onQualityReviewReset}
          />
        </div>
      );
    }

    return (
      <div className="results-wrap">
        {renderRubricSection()}
        <ManualTaskResultSection
          task={task}
          results={results}
          scoreCopyText={scoreCopyText}
          qualityMatrix={qualityMatrix}
          qualityTargetByUrl={qualityTargetByUrl}
          failSummaries={manualFailSummaries}
          failCopyText={manualFailCopyText}
          onRerun={onRerunTask}
        />
      </div>
    );
  }

  if (!allScoresReady) {
    return (
      <div className="results-wrap process-only">
        <ProcessPanel task={task} logs={logs} />
        <p className="muted">{runningStatuses.includes(task.status) ? "任务执行中，完成后显示打分结果。" : "暂无评分结果。"}</p>
      </div>
    );
  }

  return (
    <div className="results-wrap">
      {renderRubricSection()}

      <section className="score-section">
        <div className="copy-bar">
          <button className="small-button" onClick={() => void copyText(scoreCopyText)}>
            复制打分
          </button>
          <span>打分结果</span>
        </div>
        <div className="table-wrap">
          <table className="score-table">
            <thead>
              <tr>
                <th className="col-index">序号</th>
                <th className="col-url">URL前缀</th>
                {task.rubrics.map((rubric) => (
                  <th key={rubric.id} title={rubric.description}>
                    {rubric.id}
                  </th>
                ))}
                <th>总分</th>
              </tr>
            </thead>
            <tbody>
              {orderedResults.map((result, index) => {
                const total = totals.find((item) => item.url === result.url);
                const qualityTarget = qualityTargetByUrl.get(result.url);
                return (
                  <tr key={result.id}>
                    <td className="col-index">{index + 1}</td>
                    <td className="col-url">
                      <a href={result.url} target="_blank" rel="noreferrer" title={result.url}>
                        {urlPrefixBeforeHtml(result.url)}
                      </a>
                    </td>
                    {result.scores.map((score, scoreIndex) => (
                      <td
                        key={`${result.id}-${scoreIndex}`}
                        className={[score ? "pass" : "fail", qualityTarget?.rubricIndexes.includes(scoreIndex) ? "quality-target-cell" : ""]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {score}
                      </td>
                    ))}
                    <td>
                      {total?.total}/{total?.max}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ManualTaskResultSection({
  task,
  results,
  scoreCopyText,
  qualityMatrix,
  qualityTargetByUrl,
  failSummaries,
  failCopyText,
  onRerun,
}: {
  task: Task;
  results: ScoreResult[];
  scoreCopyText: string;
  qualityMatrix: number[][] | null;
  qualityTargetByUrl: Map<string, QualityMismatch>;
  failSummaries: string[];
  failCopyText: string;
  onRerun: () => void;
}) {
  return (
    <>
      <section className="score-section">
        <div className="copy-bar">
          <button className="small-button copy-action-button" onClick={() => void copyText(scoreCopyText)} disabled={!results.length}>
            复制打分
          </button>
          <span>手动检查 URL ({results.length}/{task.urls.length})</span>
        </div>
        <ul className="manual-url-list">
          {task.urls.map((url, index) => {
            const result = results.find((item) => item.url === url);
            const progress = result ? task.rubrics.length : 0;
            const qualityTarget = qualityTargetByUrl.get(url);
            const qualityScores = qualityMatrix?.[index];
            const manualCheckHref = buildManualCheckHref(task.id, url);
            return (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer" title={url}>
                  {index + 1}. {urlTail(url)}
                </a>
                <span className="manual-score-chip">{`${progress}/${task.rubrics.length}`}</span>
                <a
                  className={`button-link small-button ${index === 0 ? "manual-start-button" : ""}`}
                  href={manualCheckHref}
                  target="_blank"
                  rel="noreferrer"
                  title={qualityTarget ? `待复查 Rubric：${formatQualityRubrics(qualityTarget.rubricIndexes)}` : undefined}
                >
                  {index === 0 ? "手动检查(请从这里开始)" : "手动检查"}
                </a>
                <ScoreArrayDisplay scores={result?.scores} qualityScores={qualityScores} qualityIndexes={qualityTarget?.rubricIndexes ?? []} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="manual-reason-section">
        <div className="copy-bar">
          <button className="small-button copy-action-button" onClick={() => void copyText(failCopyText)} disabled={!failSummaries.length}>
            复制原因
          </button>
          <span>质检人理由汇总</span>
        </div>
        {failSummaries.length ? (
          <ol className="manual-reason-list">
            {failSummaries.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        ) : (
          <p className="muted">暂无质检人理由汇总，当前质检结果与作答人理由一致。</p>
        )}
      </section>
    </>
  );
}

function QualityReviewTaskResultSection({
  task,
  results,
  failSummaries,
  failCopyText,
  onReset,
}: {
  task: Task;
  results: QualityReviewResult[];
  failSummaries: string[];
  failCopyText: string;
  onReset: (task: Task, results: QualityReviewResult[]) => void;
}) {
  const orderedResults = task.urls
    .map((url) => results.find((result) => result.url === url))
    .filter((result): result is QualityReviewResult => Boolean(result));
  const allScoresReady = orderedResults.length >= task.urls.length;
  const scoreCopyText = JSON.stringify(task.urls.map((url) => results.find((result) => result.url === url)?.scores ?? []));
  const answerFailSummaries = summarizeQualityReviewBaselineReasons(task);
  const answerFailCopyText = answerFailSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");

  async function resetQualityReview() {
    if (!window.confirm("确认重置当前任务的质检分数和理由吗？")) return;
    try {
      const response = await fetch(`/api/tasks/${task.id}/quality-review-results`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { task?: Task; results?: QualityReviewResult[]; error?: string };
      if (!response.ok || !data.task || !data.results) {
        throw new Error(data.error || "重置质检失败");
      }
      onReset(data.task, data.results);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <section className="score-section">
        <div className="copy-bar">
          <div className="rubric-copy-with-warning">
            <button className="small-button copy-action-button" onClick={() => void copyText(scoreCopyText)} disabled={!results.length}>
              复制质检打分
            </button>
          </div>
          <span>手工质检 URL ({results.length}/{task.urls.length})</span>
        </div>
        <ul className="manual-url-list">
          {task.urls.map((url, index) => {
            const result = results.find((item) => item.url === url);
            const progress = result ? task.rubrics.length : 0;
            const qualityReviewHref = buildManualQualityReviewHref(task.id, url);
            const answerScores = task.qualityReviewScoreMatrix[index] ?? [];
            const mismatchIndexes = result
              ? answerScores.map((score, scoreIndex) => (result.scores[scoreIndex] !== score ? scoreIndex : -1)).filter((scoreIndex) => scoreIndex >= 0)
              : [];
            return (
              <li key={`quality-review-${url}`}>
                <a href={url} target="_blank" rel="noreferrer" title={url}>
                  {index + 1}. {urlTail(url)}
                </a>
                <span className="manual-score-chip">{`${progress}/${task.rubrics.length}`}</span>
                <a
                  className={`button-link small-button ${index === 0 ? "manual-start-button" : ""}`}
                  href={qualityReviewHref}
                  target="_blank"
                  rel="noreferrer"
                >
                  {index === 0 ? "手工质检 请从这里开始" : "手工质检"}
                </a>
                <ScoreArrayDisplay scores={answerScores} qualityScores={result?.scores} qualityIndexes={mismatchIndexes} />
              </li>
            );
          })}
        </ul>
      </section>

      {allScoresReady ? (
        <section className="score-section">
          <div className="copy-bar">
            <button className="small-button" onClick={() => void copyText(scoreCopyText)}>
              复制质检打分
            </button>
            <span>打分结果</span>
          </div>
          <div className="table-wrap">
            <table className="score-table">
              <thead>
                <tr>
                  <th className="col-index">序号</th>
                  <th className="col-url">URL前缀</th>
                  {task.rubrics.map((rubric) => (
                    <th key={rubric.id} title={rubric.description}>
                      {rubric.id}
                    </th>
                  ))}
                  <th>总分</th>
                </tr>
              </thead>
              <tbody>
                {orderedResults.map((result, index) => {
                  const total = result.scores.reduce((sum, score) => sum + score, 0);
                  return (
                    <tr key={`${result.taskId}-${result.url}`}>
                      <td className="col-index">{index + 1}</td>
                      <td className="col-url">
                        <a href={result.url} target="_blank" rel="noreferrer" title={result.url}>
                          {urlPrefixBeforeHtml(result.url)}
                        </a>
                      </td>
                      {result.scores.map((score, scoreIndex) => (
                        <td key={`${result.url}-${scoreIndex}`} className={score ? "pass" : "fail"}>
                          {score}
                        </td>
                      ))}
                      <td>
                        {total}/{task.rubrics.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {failSummaries.length ? (
        <section className="manual-reason-section">
          <div className="copy-bar">
            <button className="small-button copy-action-button" onClick={() => void copyText(failCopyText)}>
              复制原因
            </button>
            <span>质检原因汇总</span>
          </div>
          <ol className="manual-reason-list">
            {failSummaries.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </section>
      ) : null}

      {answerFailSummaries.length ? (
        <section className="manual-reason-section">
          <div className="copy-bar">
            <button className="small-button copy-action-button" onClick={() => void copyText(answerFailCopyText)}>
              复制作答人理由
            </button>
            <span>作答人理由汇总</span>
          </div>
          <ol className="manual-reason-list">
            {answerFailSummaries.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function ProcessPanel({
  task,
  logs,
}: {
  task: Task;
  logs: TaskLog[];
}) {
  const visibleLogs = logs.slice(-80);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [visibleLogs.length, visibleLogs.at(-1)?.id]);

  return (
    <section className="process-section">
      <div className="copy-bar">
        <span>执行过程</span>
        <span className="log-state">轮询更新</span>
      </div>
      {visibleLogs.length ? (
        <ol className="process-list" ref={listRef}>
          {visibleLogs.map((log) => (
            <li key={log.id}>
              <time>{formatEventTime(log.createdAt)}</time>
              <div>
                <strong>{log.message}</strong>
                {log.extra ? <p>{formatEventExtra(log.extra)}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted process-empty">
          {runningStatuses.includes(task.status) ? "等待任务事件推送..." : "暂无执行过程。"}
        </p>
      )}
    </section>
  );
}

function ScoreArrayDisplay({
  scores,
  qualityScores,
  qualityIndexes,
}: {
  scores?: number[];
  qualityScores?: number[];
  qualityIndexes: number[];
}) {
  if (!scores) return <code className="manual-score-array">[]</code>;
  const qualityIndexSet = new Set(qualityIndexes);
  const scoreCount = Math.max(scores.length, qualityScores?.length ?? 0);
  const gridStyle = { gridTemplateColumns: `34px 8px repeat(${scoreCount}, 18px) 8px` };
  return (
    <code className="manual-score-array" style={gridStyle}>
      <ScoreArrayRow label="评分" scores={scores} scoreCount={scoreCount} qualityIndexSet={qualityIndexSet} />
      {qualityScores ? <ScoreArrayRow label="质检" scores={qualityScores} scoreCount={scoreCount} qualityIndexSet={qualityIndexSet} /> : null}
    </code>
  );
}

function ScoreArrayRow({
  label,
  scores,
  scoreCount,
  qualityIndexSet,
}: {
  label: string;
  scores: number[];
  scoreCount: number;
  qualityIndexSet: Set<number>;
}) {
  return (
    <>
      <span className="score-array-label">{label}</span>
      <span>[</span>
      {Array.from({ length: scoreCount }, (_item, index) => {
        const score = scores[index];
        return (
          <span key={index} className={qualityIndexSet.has(index) ? "quality-target-score" : ""}>
            {score ?? ""}
            {index < scoreCount - 1 ? "," : ""}
          </span>
        );
      })}
      <span>]</span>
    </>
  );
}

function ReasonArrayPreview({ reasons }: { reasons?: string[] }) {
  if (!reasons?.length) return <div className="quality-review-reasons muted">未提供理由</div>;
  return (
    <ol className="quality-review-reasons">
      {reasons.map((reason, index) => (
        <li key={`${index}-${reason}`}>{`R${index + 1}: ${reason}`}</li>
      ))}
    </ol>
  );
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

function parseQualityScoreMatrix(value: string, task: Task) {
  const text = value.trim();
  if (!text) throw new Error("请粘贴质检人员给的分数数组。");

  const parsed = parseScoreMatrixInput(text);
  if (!parsed.length) throw new Error("没有识别到分数数组。");
  if (parsed.length !== task.urls.length) {
    throw new Error(`质检分数数组需要 ${task.urls.length} 行，对应当前任务的 ${task.urls.length} 个页面。`);
  }

  parsed.forEach((row, rowIndex) => {
    if (!row.length) throw new Error(`第 ${rowIndex + 1} 行为空。`);
    if (row.length !== task.rubrics.length) {
      throw new Error(`质检分数数组第 ${rowIndex + 1} 行需要 ${task.rubrics.length} 列，对应当前任务的 ${task.rubrics.length} 条 Rubric。`);
    }
  });

  return parsed;
}

function parseQualityReviewInputs({
  urls,
  rubrics,
  scoreText,
  reasonText,
}: {
  urls: string[];
  rubrics: Rubric[];
  scoreText: string;
  reasonText: string;
}) {
  const trimmedScoreText = scoreText.trim();
  const trimmedReasonText = reasonText.trim();
  if (!trimmedScoreText && !trimmedReasonText) return {};
  if (!trimmedScoreText || !trimmedReasonText) {
    throw new Error("质检评分和质检理由必须同时填写，或同时留空。");
  }
  if (!rubrics.length) {
    throw new Error("填写质检评分和质检理由时，必须同时填写 Rubrics。");
  }

  const qualityReviewScoreMatrix = parseNamedScoreMatrix(trimmedScoreText, urls.length, rubrics.length, "质检评分");
  const qualityReviewReasonMatrix = parseNamedReasonMatrix(trimmedReasonText, qualityReviewScoreMatrix, "质检理由");

  return {
    qualityReviewEnabled: true as const,
    qualityReviewScoreText: trimmedScoreText,
    qualityReviewReasonText: trimmedReasonText,
    qualityReviewScoreMatrix,
    qualityReviewReasonMatrix,
  };
}

function parseNamedScoreMatrix(text: string, urlCount: number, rubricCount: number, label: string) {
  const parsed = parseScoreMatrixInput(text);
  if (!parsed.length) throw new Error(`没有识别到${label}数组。`);
  if (parsed.length !== urlCount) {
    throw new Error(`${label}需要 ${urlCount} 行，对应当前任务的 ${urlCount} 个页面。`);
  }
  parsed.forEach((row, rowIndex) => {
    if (row.length !== rubricCount) {
      throw new Error(`${label}第 ${rowIndex + 1} 行需要 ${rubricCount} 列，对应当前任务的 ${rubricCount} 条 Rubric。`);
    }
  });
  return parsed;
}

function parseNamedReasonMatrix(text: string, scoreMatrix: number[][], label: string) {
  const flatEntries = parseFlatReasonEntries(text);
  if (flatEntries.length) {
    return buildReasonMatrixFromFlatEntries(flatEntries, scoreMatrix, label);
  }

  const parsed = parseReasonMatrixInput(text);
  const urlCount = scoreMatrix.length;
  const rubricCount = scoreMatrix[0]?.length ?? 0;
  if (!parsed.length) throw new Error(`没有识别到${label}数组。`);
  if (parsed.length !== urlCount) {
    throw new Error(`${label}需要 ${urlCount} 行，对应当前任务的 ${urlCount} 个页面。`);
  }
  parsed.forEach((row, rowIndex) => {
    if (row.length !== rubricCount) {
      throw new Error(`${label}第 ${rowIndex + 1} 行需要 ${rubricCount} 列，对应当前任务的 ${rubricCount} 条 Rubric。`);
    }
    row.forEach((reason, reasonIndex) => {
      if (!reason.trim()) {
        throw new Error(`${label}第 ${rowIndex + 1} 行第 ${reasonIndex + 1} 列不能为空。`);
      }
    });
  });
  return parsed.map((row) => row.map((reason) => reason.trim()));
}

function parseScoreMatrixInput(text: string): number[][] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.every((item) => typeof item === "number" || typeof item === "string")) {
        return [normalizeScoreRow(parsed)];
      }
      if (parsed.every(Array.isArray)) {
        return parsed.map((row) => normalizeScoreRow(row as unknown[]));
      }
    }
  } catch {
    // Fall through to tolerant line parsing.
  }

  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[|\]$/g, ""))
    .filter(Boolean);
  return rows.map((row) => normalizeScoreRow(row.split(/[\s,，;；]+/).filter(Boolean)));
}

function normalizeScoreRow(row: unknown[]) {
  return row.map((item) => {
    const score = typeof item === "number" ? item : Number(String(item).trim());
    if (score !== 0 && score !== 1) throw new Error("分数数组只能包含 0 或 1。");
    return score;
  });
}

function parseReasonMatrixInput(text: string): string[][] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.every((item) => typeof item === "string")) {
        return [normalizeReasonRow(parsed)];
      }
      if (parsed.every(Array.isArray)) {
        return parsed.map((row) => normalizeReasonRow(row as unknown[]));
      }
    }
  } catch {
    // Fall through to tolerant line parsing.
  }

  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return rows.map((row) => normalizeReasonRow(row.split(/\t|\s*\|\|\s*/).filter(Boolean)));
}

function normalizeReasonRow(row: unknown[]) {
  return row.map((item) => String(item).trim());
}

type FlatReasonEntry = {
  urlIndex: number;
  rubricIndex: number | null;
  reason: string;
};

function parseFlatReasonEntries(text: string): FlatReasonEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const entries: FlatReasonEntry[] = [];
  for (const line of lines) {
    const normalized = line.replace(/^\d+\s*[.、]\s*/, "").trim();
    const rubricMatch = normalized.match(/^第\s*(\d+)\s*个页面\s*->\s*第\s*(\d+)\s*条\s*rubrics\s*->\s*(.+)$/i);
    if (rubricMatch) {
      entries.push({
        urlIndex: Number(rubricMatch[1]) - 1,
        rubricIndex: Number(rubricMatch[2]) - 1,
        reason: rubricMatch[3].trim(),
      });
      continue;
    }

    const pageMatch = normalized.match(/^第\s*(\d+)\s*个页面\s*->\s*(.+)$/);
    if (pageMatch) {
      entries.push({
        urlIndex: Number(pageMatch[1]) - 1,
        rubricIndex: null,
        reason: pageMatch[2].trim(),
      });
      continue;
    }

    return [];
  }

  return entries;
}

function buildReasonMatrixFromFlatEntries(entries: FlatReasonEntry[], scoreMatrix: number[][], label: string) {
  const urlCount = scoreMatrix.length;
  const rubricCount = scoreMatrix[0]?.length ?? 0;
  const matrix: string[][] = scoreMatrix.map((row) => row.map((score) => (score ? "人工标记符合" : "")));
  const pageLevelReasons = new Map<number, string>();

  for (const entry of entries) {
    if (!Number.isInteger(entry.urlIndex) || entry.urlIndex < 0 || entry.urlIndex >= urlCount) {
      throw new Error(`${label}中的页面序号超出范围：第 ${entry.urlIndex + 1} 个页面。`);
    }
    if (!entry.reason) {
      throw new Error(`${label}中存在空理由，请检查平铺内容。`);
    }

    if (entry.rubricIndex === null) {
      pageLevelReasons.set(entry.urlIndex, entry.reason);
      continue;
    }

    if (!Number.isInteger(entry.rubricIndex) || entry.rubricIndex < 0 || entry.rubricIndex >= rubricCount) {
      throw new Error(`${label}中的 Rubric 序号超出范围：第 ${entry.rubricIndex + 1} 条。`);
    }

    matrix[entry.urlIndex][entry.rubricIndex] = entry.reason;
  }

  scoreMatrix.forEach((row, urlIndex) => {
    row.forEach((score, rubricIndex) => {
      if (score === 1) return;
      if (matrix[urlIndex][rubricIndex].trim()) return;
      const pageLevelReason = pageLevelReasons.get(urlIndex);
      if (pageLevelReason) {
        matrix[urlIndex][rubricIndex] = pageLevelReason;
        return;
      }
      throw new Error(`${label}缺少第 ${urlIndex + 1} 个页面第 ${rubricIndex + 1} 条 Rubric 的理由。`);
    });
  });

  return matrix;
}

function findQualityMismatches(task: Task, results: ScoreResult[], matrix: number[][]): QualityMismatch[] {
  const resultByUrl = new Map(results.map((result) => [result.url, result]));
  return task.urls
    .map((url, urlIndex) => {
      const expected = matrix[urlIndex];
      const result = resultByUrl.get(url);
      if (!expected || !result) return null;
      const rubricIndexes = expected
        .map((score, rubricIndex) => (result.scores[rubricIndex] !== score ? rubricIndex : -1))
        .filter((rubricIndex) => rubricIndex >= 0);
      return rubricIndexes.length ? { url, urlIndex, rubricIndexes } : null;
    })
    .filter((item): item is QualityMismatch => Boolean(item));
}

function buildManualCheckHref(taskId: string, url: string) {
  const params = new URLSearchParams({ url });
  return `/manual/${encodeURIComponent(taskId)}?${params.toString()}`;
}

function buildManualQualityReviewHref(taskId: string, url: string) {
  const params = new URLSearchParams({ url });
  return `/manual-quality/${encodeURIComponent(taskId)}?${params.toString()}`;
}

function isQualityReviewConfigured(task: Task) {
  return (
    task.qualityReviewEnabled &&
    task.qualityReviewScoreMatrix.length === task.urls.length &&
    task.qualityReviewReasonMatrix.length === task.urls.length &&
    task.qualityReviewScoreMatrix.every((row) => row.length === task.rubrics.length) &&
    task.qualityReviewReasonMatrix.every((row) => row.length === task.rubrics.length)
  );
}

function formatQualityRubrics(indexes: number[]) {
  return indexes.map((index) => `R${index + 1}`).join(", ");
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge status-${status}`}>{statusLabel(status)}</span>;
}

function parseUrls(value: string) {
  const text = value.trim();
  if (!text) throw new Error("请粘贴产物 URL 数组。");

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return validateUrls(parsed);
    }
  } catch {
    // Fall through to tolerant URL extraction for pasted JS arrays.
  }

  const matched = text.match(/https?:\/\/[^"',\]\s]+/g);
  if (matched?.length) return validateUrls(matched);

  return validateUrls(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function validateUrls(values: string[]) {
  const urls = Array.from(new Set(values.map((url) => url.trim()).filter(Boolean)));
  if (!urls.length) throw new Error("没有解析到 URL。");
  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      throw new Error(`URL 不合法：${url}`);
    }
  }
  return urls;
}

function looksLikeHtmlOrReactLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^<!DOCTYPE\s+html/i.test(text)) return true;
  if (/^<\/?[A-Za-z][\w:-]*[\s/>]/.test(text)) return true;
  if (/\bclassName\s*=/.test(text)) return true;
  if (/^import\s+.*\s+from\s+['"]react['"]/i.test(text)) return true;
  if (/^import\s+React\b/.test(text)) return true;
  if (/^export\s+default\s+function\b/.test(text)) return true;
  if (/^export\s+function\s+\w+/.test(text)) return true;
  if (/^(?:const|let|var)\s+\w+\s*=\s*\([^)]*\)\s*=>/.test(text)) return true;
  return false;
}

function clearRubricsTextIfHtmlOrReact(value: string): string {
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  if (looksLikeHtmlOrReactLine(firstLine)) return "";
  return value;
}

function parseRubricsInput(value: string): Rubric[] {
  const text = clearRubricsTextIfHtmlOrReact(value).trim();
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map(stripRubricListMarker)
    .filter(Boolean);

  if (!lines.length) throw new Error("请按一行一条规则填写 Rubrics，或留空自动生成。");
  return lines.map((description, index) => ({
    id: `R${index + 1}`,
    name: `规则 ${index + 1}`,
    description,
    evidenceHints: [],
  }));
}

function stripRubricListMarker(value: string) {
  return value.trim().replace(/^\d+\s*(?:[、。．)）]|\.(?=\s))\s*/, "").trim();
}

function normalizeRubricsIfNeeded(rubrics: Rubric[]) {
  let changed = false;
  const normalized = rubrics.map((rubric) => {
    const description = stripRubricNumberPrefix(rubric.description);
    if (description !== rubric.description.trim()) changed = true;
    return { ...rubric, description };
  });
  return changed ? normalized : null;
}

function reorderList<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function buildRubricPermutation(fromIndex: number, toIndex: number, length: number): number[] {
  const order = Array.from({ length }, (_, index) => index);
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved);
  return order;
}

function stripRubricNumberPrefix(value: string) {
  return value.replace(/^\s*\d+\s*[.、。．)\]）]\s*/, "").trim();
}

function parseCaseRows(value: string): ParsedCaseRow[] {
  const text = value.trim();
  if (!text) return [];

  return splitCaseRows(text)
    .map(parseCaseRowWithQuality)
    .filter((row): row is ParsedCaseRow => Boolean(row));
}

function splitCaseRows(value: string) {
  const text = value.replace(/\r\n/g, "\n").trim();
  const rowStarts = Array.from(text.matchAll(/(^|\n)([A-Za-z0-9][A-Za-z0-9_-]*)\t/g)).map((match) => ({
    index: (match.index ?? 0) + (match[1] ? match[1].length : 0),
  }));

  if (rowStarts.length <= 1) return [text];

  return rowStarts
    .map((start, index) => {
      const next = rowStarts[index + 1]?.index ?? text.length;
      return text.slice(start.index, next).trim();
    })
    .filter(Boolean);
}

function parseCaseRowPartial(value: string): ParsedCaseRow {
  const empty: ParsedCaseRow = {
    id: "",
    prompt: "",
    urlsText: "",
    rubricsText: "",
    qualityReviewScoreText: "",
    qualityReviewReasonText: "",
  };

  const text = value.trim();
  if (!text) return empty;

  const cells = text
    .split("\t")
    .map(normalizeCaseCell)
    .filter(Boolean);
  if (!cells.length) return empty;

  const urlCellIndex = cells.findIndex((cell) => /^["']?\s*\[/.test(cell) && /https?:\/\//i.test(cell));
  if (urlCellIndex >= 1) {
    const id = looksLikeTaskIdCell(cells[0]) && urlCellIndex > 0 ? cells[0] : "";
    const promptStart = id ? 1 : 0;
    const prompt = cells.slice(promptStart, urlCellIndex).join("\n\n").trim();

    let urlsText = "";
    try {
      parseUrls(cells[urlCellIndex]);
      urlsText = cells[urlCellIndex];
    } catch {
      urlsText = "";
    }

    const { rubricsSource, qualityReviewScoreText, qualityReviewReasonText } = extractCaseReviewFields(cells.slice(urlCellIndex + 1));
    const rubricsText =
      rubricsSource && isLikelyRubricsCell(rubricsSource) ? normalizeCaseRubricsText(rubricsSource) : "";

    return {
      id,
      prompt,
      urlsText,
      rubricsText,
      qualityReviewScoreText,
      qualityReviewReasonText,
    };
  }

  if (cells.length === 1) {
    if (looksLikeTaskIdCell(cells[0])) return { ...empty, id: cells[0] };
    return { ...empty, prompt: text };
  }

  const id = looksLikeTaskIdCell(cells[0]) ? cells[0] : "";
  const prompt = id ? cells.slice(1).join("\n\n").trim() : text;
  return { ...empty, id, prompt };
}

function looksLikeTaskIdCell(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.trim());
}

function parseCaseRow(value: string): ParsedCaseRow | null {
  const partial = parseCaseRowPartial(value);
  if (!partial.id || !partial.prompt || !partial.urlsText) return null;
  try {
    parseUrls(partial.urlsText);
  } catch {
    return null;
  }
  return partial;
}

function parseCaseRowWithQuality(value: string): ParsedCaseRow | null {
  return parseCaseRow(value);
}

function extractCaseReviewFields(cells: string[]) {
  let rubricCells = [...cells];
  let qualityReviewScoreText = "";
  let qualityReviewReasonText = "";

  const lastCell = rubricCells[rubricCells.length - 1]?.trim() ?? "";
  if (looksLikeCaseReasonMatrixCell(lastCell)) {
    qualityReviewReasonText = rubricCells.pop() ?? "";
    const scoreCell = rubricCells[rubricCells.length - 1]?.trim() ?? "";
    if (looksLikeCaseScoreMatrixCell(scoreCell)) {
      qualityReviewScoreText = rubricCells.pop() ?? "";
    } else {
      qualityReviewReasonText = "";
      rubricCells = [...cells];
    }
  }

  const rubricsSource =
    rubricCells
      .slice()
      .reverse()
      .find(isLikelyRubricsCell) ??
    rubricCells[rubricCells.length - 1] ??
    "";

  return {
    rubricsSource,
    qualityReviewScoreText,
    qualityReviewReasonText,
  };
}

function looksLikeCaseScoreMatrixCell(value: string) {
  const text = value.trim();
  if (!text) return false;
  if (!/^[\[\]\s\r\n,01]+$/.test(text)) return false;
  try {
    return parseScoreMatrixInput(text).length > 0;
  } catch {
    return false;
  }
}

function looksLikeCaseReasonMatrixCell(value: string) {
  const text = value.trim();
  if (!text) return false;
  if (parseFlatReasonEntries(text).length > 0) return true;
  if (!(text.startsWith("[[") || text.includes("\t") || text.includes("||"))) return false;
  try {
    return parseReasonMatrixInput(text).length > 0;
  } catch {
    return false;
  }
}

function isLikelyRubricsCell(value: string) {
  const text = value.trim().toLowerCase();
  if (!text) return false;
  if (text.includes("rubrics")) return true;
  if (/\d+\s*[.)、]/.test(text)) return true;
  return ["页面", "功能", "支持", "提供", "使用", "展示", "验证", "点击"].some((keyword) => value.includes(keyword));
}

function normalizeCaseCell(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
}

function normalizeCaseRubricsText(value: string) {
  const cleared = clearRubricsTextIfHtmlOrReact(value);
  if (!cleared.trim()) return "";

  const lines = cleared
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1) return lines.map(stripRubricListMarker).filter(Boolean).join("\n");

  const matched = cleared.match(/\d+\s*[.、][\s\S]*?(?=\s+\d+\s*[.、]|$)/g);
  return (matched?.length ? matched : lines).map(stripRubricListMarker).filter(Boolean).join("\n");
}

function summarizeManualFailReasons(task: Task, results: ScoreResult[]) {
  const summaries: string[] = [];
  const resultByUrl = new Map(results.map((result) => [result.url, result]));

  task.urls.forEach((url, urlIndex) => {
    const result = resultByUrl.get(url);
    if (!result) return;
    const pageFailReason = getPageFailReason(result);
    if (pageFailReason) {
      summaries.push(`第${urlIndex + 1}个页面->${pageFailReason}`);
      return;
    }

    task.rubrics.forEach((_rubric, rubricIndex) => {
      if (result.scores[rubricIndex] !== 0) return;
      const reason = normalizeManualFailReason(result.reasons[rubricIndex]);
      summaries.push(`第${urlIndex + 1}个页面->第${rubricIndex + 1}条rubrics->${reason}`);
    });
  });

  return summaries;
}

function summarizeQualityReviewReviewerReasons(task: Task, results: QualityReviewResult[]) {
  const summaries: string[] = [];
  const resultByUrl = new Map(results.map((result) => [result.url, result]));

  task.urls.forEach((url, urlIndex) => {
    const result = resultByUrl.get(url);
    if (!result) return;
    const baselineScores = task.qualityReviewScoreMatrix[urlIndex] ?? [];
    const baselineReasons = task.qualityReviewReasonMatrix[urlIndex] ?? [];

    task.rubrics.forEach((_rubric, rubricIndex) => {
      if (result.scores[rubricIndex] === baselineScores[rubricIndex]) return;
      const reason = normalizeManualFailReason(result.reasons[rubricIndex]);
      const baselineReason = normalizeManualFailReason(baselineReasons[rubricIndex]);
      if (reason === baselineReason) return;
      summaries.push(`第${urlIndex + 1}个页面->第${rubricIndex + 1}条rubrics->${reason}`);
    });
  });

  return summaries;
}

function summarizeQualityReviewBaselineReasons(task: Task) {
  const summaries: string[] = [];

  task.urls.forEach((_, urlIndex) => {
    const scores = task.qualityReviewScoreMatrix[urlIndex] ?? [];
    const reasons = task.qualityReviewReasonMatrix[urlIndex] ?? [];

    task.rubrics.forEach((_rubric, rubricIndex) => {
      if (scores[rubricIndex] !== 0) return;
      const reason = normalizeManualFailReason(reasons[rubricIndex]);
      summaries.push(`第${urlIndex + 1}个页面->第${rubricIndex + 1}条rubrics->${reason}`);
    });
  });

  return summaries;
}

function getPageFailReason(result: ScoreResult) {
  const technology = result.evidence?.technology;
  if (!technology || typeof technology !== "object") return "";
  const reason = (technology as { pageFailReason?: unknown }).pageFailReason;
  return typeof reason === "string" ? reason.trim() : "";
}

function normalizeManualFailReason(reason: string | undefined) {
  const value = reason?.trim();
  if (!value || value === "人工未标记符合") return "未填写原因";
  return value;
}

function taskCompletedPageCount(task: Task) {
  return task.qualityReviewEnabled ? (task.qualityReviewResultCount ?? 0) : (task.resultCount ?? 0);
}

function taskProgress(task: Task) {
  const completedPageCount = taskCompletedPageCount(task);
  if (task.qualityReviewEnabled && task.mode === "manual") {
    if (completedPageCount >= task.urls.length && task.urls.length > 0) return 100;
    if (task.status === "error") return Math.min(99, Math.round((completedPageCount / Math.max(task.urls.length, 1)) * 100));
    if (task.status === "generating-rubrics") return 10;
    if (task.status === "queued") return 2;
    return Math.min(99, 20 + Math.round((completedPageCount / Math.max(task.urls.length, 1)) * 75));
  }
  if (task.status === "scored") return 100;
  if (task.status === "error") return Math.min(99, Math.round((completedPageCount / Math.max(task.urls.length, 1)) * 100));
  if (task.status === "generating-rubrics") return 10;
  if (task.status === "rubrics-ready") {
    return task.mode === "manual" ? Math.min(99, 20 + Math.round((completedPageCount / Math.max(task.urls.length, 1)) * 75)) : 20;
  }
  if (task.status === "scoring") {
    return Math.min(99, 15 + Math.round((completedPageCount / Math.max(task.urls.length, 1)) * 80));
  }
  if (task.status === "queued") return 2;
  return 0;
}

function taskProgressOldUnused(task: Task) {
  task;
  return 0;
}
/*
  task.rubrics.forEach((_rubric, rubricIndex) => {
    const groups = new Map<string, number[]>();
    task.urls.forEach((url, urlIndex) => {
      const result = resultByUrl.get(url);
      if (!result || result.scores[rubricIndex] !== 0) return;
      const reason = normalizeManualFailReason(result.reasons[rubricIndex]);
      const pages = groups.get(reason) ?? [];
      pages.push(urlIndex + 1);
      groups.set(reason, pages);
    });

    groups.forEach((pages, reason) => {
      const pageLabel =
        pages.length === task.urls.length
          ? "所有页面"
          : pages.length === 1
            ? `第${pages[0]}个页面`
            : `第${pages.join("、")}个页面`;
      summaries.push(`${pageLabel} -> 第${rubricIndex + 1}条rubrics -> ${reason}`);
    });
  });

  return summaries;
}

function normalizeManualFailReason(reason: string | undefined) {
  const value = reason?.trim();
  if (!value || value === "人工未标记符合") return "未填写原因";
  return value;
}

function taskProgress(task: Task) {
  if (task.status === "scored") return 100;
  if (task.status === "error") return Math.min(99, Math.round(((task.resultCount ?? 0) / Math.max(task.urls.length, 1)) * 100));
  if (task.status === "generating-rubrics") return 10;
  if (task.status === "rubrics-ready") {
    return task.mode === "manual" ? Math.min(99, 20 + Math.round(((task.resultCount ?? 0) / Math.max(task.urls.length, 1)) * 75)) : 20;
  }
  if (task.status === "scoring") {
    return Math.min(99, 15 + Math.round(((task.resultCount ?? 0) / Math.max(task.urls.length, 1)) * 80));
  }
  if (task.status === "queued") return 2;
  return 0;
}

*/

function statusLabel(status: TaskStatus) {
  const labels: Record<TaskStatus, string> = {
    draft: "草稿",
    queued: "排队中",
    "generating-rubrics": "生成规则",
    "rubrics-ready": "规则完成",
    scoring: "评分中",
    scored: "完成",
    error: "失败",
  };
  return labels[status];
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEventExtra(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  const preferred = entries
    .filter(([key]) => ["url", "urls", "count", "scores", "total", "error", "results", "rubrics"].includes(key))
    .map(([key, entry]) => `${key}: ${Array.isArray(entry) ? entry.join(", ") : String(entry)}`);
  if (preferred.length) return preferred.join(" | ");
  return JSON.stringify(value);
}

function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return `${parsed.host}/${parts.slice(-2).join("/")}`;
  } catch {
    return url;
  }
}

function urlTail(url: string) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return tail || parsed.host;
  } catch {
    return url.length > 42 ? url.slice(-42) : url;
  }
}

function urlPrefixBeforeHtml(url: string) {
  try {
    const parsed = new URL(url);
    const prefix = parsed.pathname.replace(/\.html?$/i, "");
    return `${parsed.host}${prefix}` || parsed.host;
  } catch {
    return url.replace(/\.html?(\?|#|$)/i, "");
  }
}

