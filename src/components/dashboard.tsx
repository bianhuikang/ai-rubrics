"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RUBRIC_PROMPT, DEFAULT_SCORING_PROMPT } from "@/lib/default-prompts";
import type { Rubric, ScoreResult, Settings, SettingsConfig, Task, TaskLog, TaskStatus } from "@/lib/types";

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
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [taskLogs, setTaskLogs] = useState<TaskLog[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [testResult, setTestResult] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const [rubricsReviewOpen, setRubricsReviewOpen] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [rubricsText, setRubricsText] = useState("");
  const manualMode = true;

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (activeTask) {
      void loadResults(activeTask.id);
      void loadTaskLogs(activeTask.id);
    } else {
      setResults([]);
      setTaskLogs([]);
    }
  }, [activeTask?.id]);

  useEffect(() => {
    const shouldPoll = runningTaskIds.size > 0;
    if (!shouldPoll) return;

    const timer = window.setInterval(() => {
      void refreshAll({ keepSelection: true });
      if (activeTask) {
        void loadResults(activeTask.id);
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
    }, 2000);

    return () => window.clearInterval(timer);
  }, [activeTask?.id, activeTask?.mode, activeTask?.status]);

  useEffect(() => {
    if (!activeTask) return;

    const refreshActiveTaskResults = () => {
      void refreshAll({ keepSelection: true });
      void loadResults(activeTask.id);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "manual-score-updated" || !event.newValue) return;
      try {
        const payload = JSON.parse(event.newValue) as { taskId?: string };
        if (payload.taskId === activeTask.id) refreshActiveTaskResults();
      } catch {
        refreshActiveTaskResults();
      }
    };

    const handleFocus = () => {
      refreshActiveTaskResults();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshActiveTaskResults();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
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

  const taskStats = useMemo(() => {
    const completed = tasks.filter((task) => task.status === "scored").length;
    return {
      total: tasks.length,
      completed,
      unfinished: tasks.length - completed,
    };
  }, [tasks]);

  async function refreshAll(options: { keepSelection?: boolean } = {}) {
    const [settingsResponse, tasksResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/tasks")]);
    const nextSettings = (await settingsResponse.json()) as SettingsResponse;
    const taskData = (await tasksResponse.json()) as { tasks: Task[] };
    applySettingsResponse(nextSettings);
    setTasks(taskData.tasks);
    setActiveTask((current) => {
      if (options.keepSelection && current) {
        return taskData.tasks.find((task) => task.id === current.id) ?? current;
      }
      return current ? taskData.tasks.find((task) => task.id === current.id) ?? current : taskData.tasks[0] ?? null;
    });
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
    try {
      urls = parseUrls(urlsText);
      rubrics = parseRubricsInput(rubricsText);
      if (!promptText && !rubrics.length) {
        throw new Error("需要自动生成 Rubrics 时请填写 Prompt；手填 Rubrics 时可以不填。");
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      return;
    }

    await run("create", "任务已创建，已自动开始执行。", async () => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id || undefined, prompt: promptText, urls, rubrics, mode: manualMode ? "manual" : "auto" }),
      });
      if (!response.ok) throw new Error(await response.text());
      const task = (await response.json()) as Task;
      setTasks((current) => [task, ...current]);
      setActiveTask(task);
      setResults([]);
      setTaskLogs([]);
      void runTask(task.id);
    });
  }

  async function parseClipboardCase() {
    try {
      const text = await navigator.clipboard.readText();
      const parsedRows = parseCaseRows(text);
      if (!parsedRows.length) {
        setNotice({ kind: "error", text: "没有识别到表格行，请复制包含任务ID、Prompt、URL数组、Rubrics的行。" });
        return;
      }
      if (parsedRows.length === 1) {
        applyPastedCase(parsedRows[0]);
        return;
      }
      await createParsedCaseTasks(parsedRows);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  function applyPastedCase(parsed: ParsedCaseRow) {
    setTaskId(parsed.id);
    setPrompt(parsed.prompt);
    setUrlsText(parsed.urlsText);
    setRubricsText(parsed.rubricsText);
    setNotice({ kind: "success", text: "已解析到表单。" });
  }

  async function createParsedCaseTasks(parsedRows: ParsedCaseRow[]) {
    try {
      setBusy("batch-create");
      const existingIds = new Set(tasks.map((task) => task.id));
      const seenIds = new Set<string>();
      const uniqueRows = parsedRows.filter((row) => {
        const id = row.id.trim();
        if (!id || existingIds.has(id) || seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      const skippedCount = parsedRows.length - uniqueRows.length;
      if (!uniqueRows.length) {
        setNotice({ kind: "info", text: `没有创建新任务，已跳过 ${skippedCount} 个重复任务 ID。` });
        return;
      }

      setNotice({ kind: "info", text: `正在批量创建 ${uniqueRows.length} 个任务${skippedCount ? `，跳过 ${skippedCount} 个重复ID` : ""}...` });
      const createdTasks: Task[] = [];
      const errors: string[] = [];
      for (const parsed of uniqueRows) {
        try {
          const response = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: parsed.id || undefined,
              prompt: parsed.prompt,
              urls: parseUrls(parsed.urlsText),
              rubrics: parseRubricsInput(parsed.rubricsText),
              mode: manualMode ? "manual" : "auto",
            }),
          });
          if (!response.ok) throw new Error(await response.text());
          const task = (await response.json()) as Task;
          createdTasks.push(task);
        } catch (error) {
          errors.push(`${parsed.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (createdTasks.length) {
        setTasks((current) => [...createdTasks, ...current]);
        setActiveTask(createdTasks[0]);
        setResults([]);
        setTaskLogs([]);
        createdTasks.forEach((task) => void runTask(task.id));
      }

      if (errors.length) {
        setNotice({
          kind: createdTasks.length ? "info" : "error",
          text: `已创建 ${createdTasks.length} 个，跳过 ${skippedCount} 个重复ID，失败 ${errors.length} 个：${errors.slice(0, 2).join("；")}`,
        });
      } else {
        setNotice({ kind: "success", text: `已批量创建 ${createdTasks.length} 个任务${skippedCount ? `，跳过 ${skippedCount} 个重复ID` : ""}。` });
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

  async function rerunActiveTask() {
    if (!activeTask) return;
    setNotice({ kind: "info", text: `任务 ${activeTask.id} 已重新开始。` });
    setResults([]);
    setTaskLogs([]);
    void runTask(activeTask.id);
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
                创建并执行
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
              onChange={(event) => setRubricsText(event.target.value)}
              rows={8}
              placeholder={"留空则自动生成；手填时一行一条规则。"}
            />
          </label>
        </section>

        <section className="compact-panel task-panel">
          <div className="panel-header">
            <div className="task-title-line">
              <h2>任务列表</h2>
              <span>总数 {taskStats.total}</span>
              <span>已完成 {taskStats.completed}</span>
              <span>未完成 {taskStats.unfinished}</span>
            </div>
            <button onClick={() => void refreshAll({ keepSelection: true })}>刷新</button>
          </div>
          <div className="table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>任务 ID</th>
                  <th>状态</th>
                  <th>URL</th>
                  <th>进度</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length ? (
                  tasks.map((task) => {
                    const progress = taskProgress(task);
                    return (
                      <tr
                        key={task.id}
                        className={[activeTask?.id === task.id ? "active-row" : "", `task-row-${task.status}`].filter(Boolean).join(" ")}
                        onClick={() => {
                          setActiveTask(task);
                          void loadResults(task.id);
                        }}
                      >
                        <td className="mono">{task.id}</td>
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td>
                          {task.resultCount ?? 0}/{task.urls.length}
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
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} className="empty-cell">
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
                <button onClick={() => setRubricsReviewOpen(true)} disabled={!activeTask.rubrics.length}>
                  检查 Rubrics
                </button>
                <button onClick={rerunActiveTask} disabled={runningTaskIds.has(activeTask.id)}>
                  重跑
                </button>
                <a className="button-link" href={`/api/tasks/${activeTask.id}/export?format=json`} target="_blank" rel="noreferrer">
                  JSON
                </a>
                <a className="button-link" href={`/api/tasks/${activeTask.id}/export?format=csv`}>
                  CSV
                </a>
              </div>
            ) : null}
          </div>

          {activeTask ? (
            <ResultView
              task={activeTask}
              results={results}
              totals={activeTotals}
              logs={taskLogs}
              onRubricsUpdated={(updatedTask, updatedResults) => {
                setTasks((current) => current.map((task) => (task.id === updatedTask.id ? updatedTask : task)));
                setActiveTask((current) => (current?.id === updatedTask.id ? updatedTask : current));
                setResults(updatedResults);
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
                <input value={settings.endpointUrl} onChange={(event) => setSettings({ ...settings, endpointUrl: event.target.value })} />
              </label>
              <label>
                API Key
                <input type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} />
              </label>
              <label>
                Model
                <input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
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
  totals,
  logs,
  onRubricsUpdated,
}: {
  task: Task;
  results: ScoreResult[];
  totals: Array<{ url: string; total: number; max: number }>;
  logs: TaskLog[];
  onRubricsUpdated: (task: Task, results: ScoreResult[]) => void;
}) {
  const [rubricDrafts, setRubricDrafts] = useState<string[]>(() => task.rubrics.map((rubric) => rubric.description));
  const [rubricBusy, setRubricBusy] = useState<number | null>(null);
  const [rubricError, setRubricError] = useState("");

  useEffect(() => {
    setRubricDrafts(task.rubrics.map((rubric) => rubric.description));
    setRubricError("");
  }, [task.id, task.rubrics]);

  const rubricsCopyText = task.rubrics.map((rubric, index) => `${index + 1}. ${rubric.description}`).join("\n");
  const orderedResults = task.urls
    .map((url) => results.find((result) => result.url === url))
    .filter((result): result is ScoreResult => Boolean(result));
  const allScoresReady = task.status === "scored" && orderedResults.length >= task.urls.length;
  const scoreCopyText = JSON.stringify(orderedResults.map((result) => result.scores));
  const manualFailSummaries = task.mode === "manual" ? summarizeManualFailReasons(task, results) : [];
  const manualFailCopyText = manualFailSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");

  async function persistRubrics(nextDescriptions: string[], removedIndexes: number[] = []) {
    const rubrics = nextDescriptions.map((description, index) => ({
      id: `R${index + 1}`,
      name: task.rubrics[index]?.name || `规则 ${index + 1}`,
      description: description.trim(),
      evidenceHints: task.rubrics[index]?.evidenceHints || [],
    }));
    const response = await fetch(`/api/tasks/${task.id}/rubrics`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rubrics, removedIndexes }),
    });
    const data = (await response.json()) as { task?: Task; results?: ScoreResult[]; error?: string };
    if (!response.ok || !data.task || !data.results) throw new Error(data.error || "Rubrics 保存失败");
    onRubricsUpdated(data.task, data.results);
  }

  async function saveRubric(index: number) {
    const value = rubricDrafts[index]?.trim();
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
    if (task.rubrics.length <= 1) {
      setRubricError("至少保留 1 条 Rubric。");
      return;
    }
    if (!window.confirm(`确认删除第 ${index + 1} 条 Rubric？对应打分和汇总也会同步删除。`)) return;
    try {
      setRubricBusy(index);
      setRubricError("");
      await persistRubrics(
        rubricDrafts.filter((_item, itemIndex) => itemIndex !== index),
        [index],
      );
    } catch (error) {
      setRubricError(error instanceof Error ? error.message : String(error));
    } finally {
      setRubricBusy(null);
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
            <strong>修改后立即应用，请刷新检查页面</strong>
          </div>
          <span>Rubrics ({task.rubrics.length})</span>
        </div>
        <ol className="rubric-list editable-rubric-list">
          {task.rubrics.map((rubric, index) => (
            <li key={rubric.id}>
              <input
                value={rubricDrafts[index] ?? rubric.description}
                onChange={(event) =>
                  setRubricDrafts((current) => current.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))
                }
              />
              <div className="rubric-edit-actions">
                <button className="small-button" onClick={() => void saveRubric(index)} disabled={rubricBusy !== null}>
                  保存
                </button>
                <button className="small-button danger-button" onClick={() => void deleteRubric(index)} disabled={rubricBusy !== null}>
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
      <div className="results-wrap process-only">
        <ProcessPanel task={task} logs={logs} />
        <p className="error-text">{task.error || "任务执行失败。"}</p>
      </div>
    );
  }

  if (task.mode === "manual" && task.rubrics.length > 0) {
    return (
      <div className="results-wrap">
        {renderRubricSection()}

        <section className="score-section">
          <div className="copy-bar">
            <button className="small-button copy-action-button" onClick={() => void copyText(scoreCopyText)} disabled={!orderedResults.length}>
              复制打分
            </button>
            <span>手动检查 URL ({orderedResults.length}/{task.urls.length})</span>
          </div>
          <ul className="manual-url-list">
            {task.urls.map((url, index) => {
              const result = results.find((item) => item.url === url);
              const progress = result ? task.rubrics.length : 0;
              return (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer" title={url}>
                    {index + 1}. {urlTail(url)}
                  </a>
                  <span className="manual-score-chip">{`${progress}/${task.rubrics.length}`}</span>
                  <a
                    className={`button-link small-button ${index === 0 ? "manual-start-button" : ""}`}
                    href={`/manual/${encodeURIComponent(task.id)}?url=${encodeURIComponent(url)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {index === 0 ? "手动检查(请从这里开始)" : "手动检查"}
                  </a>
                  <code className="manual-score-array">{result ? JSON.stringify(result.scores) : "[]"}</code>
                </li>
              );
            })}
          </ul>
        </section>

        {manualFailSummaries.length ? (
          <section className="manual-reason-section">
            <div className="copy-bar">
              <button className="small-button copy-action-button" onClick={() => void copyText(manualFailCopyText)}>
                复制原因
              </button>
              <span>不符合原因汇总</span>
            </div>
            <ol className="manual-reason-list">
              {manualFailSummaries.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </section>
        ) : null}
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
                <th className="col-url">产物尾部</th>
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
                return (
                  <tr key={result.id}>
                    <td className="col-index">{index + 1}</td>
                    <td className="col-url">
                      <a href={result.url} target="_blank" rel="noreferrer" title={result.url}>
                        {urlTail(result.url)}
                      </a>
                    </td>
                    {result.scores.map((score, scoreIndex) => (
                      <td key={`${result.id}-${scoreIndex}`} className={score ? "pass" : "fail"}>
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

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
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

function parseRubricsInput(value: string): Rubric[] {
  const text = value.trim();
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) throw new Error("请按一行一条规则填写 Rubrics，或留空自动生成。");
  return lines.map((description, index) => ({
    id: `R${index + 1}`,
    name: `规则 ${index + 1}`,
    description,
    evidenceHints: [],
  }));
}

function parseCaseRows(value: string): ParsedCaseRow[] {
  const text = value.trim();
  if (!text) return [];

  return splitCaseRows(text)
    .map(parseCaseRow)
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

function parseCaseRow(value: string): ParsedCaseRow | null {
  const text = value.trim();
  if (!text) return null;

  const cells = text
    .split("\t")
    .map(normalizeCaseCell)
    .filter(Boolean);
  const urlCellIndex = cells.findIndex((cell) => /^["']?\s*\[/.test(cell) && /https?:\/\//i.test(cell));
  if (cells.length < 3 || urlCellIndex < 1) return null;

  const id = cells[0];
  const prompt = cells.slice(1, urlCellIndex).join("\n\n").trim();
  const urlsText = cells[urlCellIndex];
  const rubricsSource = cells
    .slice(urlCellIndex + 1)
    .reverse()
    .find((cell) => /\d+\s*[.、]|rubrics|页面|功能|支持|提供|使用|展示|验证|点击/i.test(cell));

  if (!id || !prompt || !urlsText || !rubricsSource) return null;

  try {
    parseUrls(urlsText);
  } catch {
    return null;
  }

  return {
    id,
    prompt,
    urlsText,
    rubricsText: normalizeCaseRubricsText(rubricsSource),
  };
}

function normalizeCaseCell(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
}

function normalizeCaseRubricsText(value: string) {
  const lines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1) return lines.join("\n");

  const matched = value.match(/\d+\s*[.、][\s\S]*?(?=\s+\d+\s*[.、]|$)/g);
  return (matched?.length ? matched : lines).map((line) => line.trim()).filter(Boolean).join("\n");
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
