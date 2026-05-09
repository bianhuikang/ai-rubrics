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

  const activeTotals = useMemo(() => {
    return results.map((result) => ({
      url: result.url,
      total: result.scores.reduce((sum, score) => sum + score, 0),
      max: activeTask?.rubrics.length ?? result.scores.length,
    }));
  }, [activeTask?.rubrics.length, results]);

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
    let urls: string[];
    let rubrics: Rubric[];
    try {
      urls = parseUrls(urlsText);
      rubrics = parseRubricsInput(rubricsText);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      return;
    }

    await run("create", "任务已创建，已自动开始执行。", async () => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id || undefined, prompt, urls, rubrics, mode: manualMode ? "manual" : "auto" }),
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
            <button className="primary" onClick={createTask} disabled={Boolean(busy)}>
              创建并执行
            </button>
          </div>
          <label>
            任务 ID
            <input value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="不填自动生成" />
          </label>
          <label>
            Prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} />
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
              placeholder={"留空则自动生成；也可粘贴编号列表或 JSON rubrics。"}
            />
          </label>
        </section>

        <section className="compact-panel task-panel">
          <div className="panel-header">
            <h2>任务列表</h2>
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
                        className={activeTask?.id === task.id ? "active-row" : ""}
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
            />
          ) : (
            <p className="muted">从任务列表选择一行查看结果。</p>
          )}
        </section>
      </section>

      {settingsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <h2>模型配置</h2>
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
}: {
  task: Task;
  results: ScoreResult[];
  totals: Array<{ url: string; total: number; max: number }>;
  logs: TaskLog[];
}) {
  const rubricsCopyText = task.rubrics.map((rubric, index) => `${index + 1}. ${rubric.description}`).join("\n");
  const orderedResults = task.urls
    .map((url) => results.find((result) => result.url === url))
    .filter((result): result is ScoreResult => Boolean(result));
  const allScoresReady = task.status === "scored" && orderedResults.length >= task.urls.length;
  const scoreCopyText = JSON.stringify(orderedResults.map((result) => result.scores));
  const manualFailSummaries = task.mode === "manual" ? summarizeManualFailReasons(task, results) : [];
  const manualFailCopyText = manualFailSummaries.join("\n");

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
        <section className="rubric-section">
          <div className="copy-bar">
            <button className="small-button" onClick={() => void copyText(rubricsCopyText)}>
              复制 Rubrics
            </button>
            <span>Rubrics ({task.rubrics.length})</span>
          </div>
          <ol className="rubric-list">
            {task.rubrics.map((rubric) => (
              <li key={rubric.id}>
                <span>{rubric.id}. {rubric.description}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="score-section">
          <div className="copy-bar">
            <button className="small-button" onClick={() => void copyText(scoreCopyText)} disabled={!orderedResults.length}>
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
                    className="button-link small-button"
                    href={`/manual/${encodeURIComponent(task.id)}?url=${encodeURIComponent(url)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    手动检查
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
              <button className="small-button" onClick={() => void copyText(manualFailCopyText)}>
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
      <section className="rubric-section">
        <div className="copy-bar">
          <button
            className="small-button"
            onClick={() => void copyText(rubricsCopyText)}
          >
            复制 Rubrics
          </button>
          <span>Rubrics ({task.rubrics.length})</span>
        </div>
        <ol className="rubric-list">
          {task.rubrics.map((rubric) => (
            <li key={rubric.id}>
              <span>{rubric.id}. {rubric.description}</span>
            </li>
          ))}
        </ol>
      </section>

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
  if (text.replace(/\s/g, "").length <= 50) {
    throw new Error("用户输入的 Rubrics 需要超过 50 个字；不填则自动生成。");
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { rubrics?: unknown }).rubrics)
        ? (parsed as { rubrics: unknown[] }).rubrics
        : null;
    if (items) return items.map((item, index) => normalizeRubricItem(item, index));
  } catch {
    // Fall through to numbered/plain-line parsing.
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:R?\d+[\.\、\)\s]+|[-*]\s+)/i, "").trim())
    .filter(Boolean);

  if (!lines.length) throw new Error("Rubrics 内容为空或格式不正确。");
  return lines.map((description, index) => ({
    id: `R${index + 1}`,
    name: `规则 ${index + 1}`,
    description,
    evidenceHints: [],
  }));
}

function normalizeRubricItem(item: unknown, index: number): Rubric {
  if (typeof item === "string") {
    const description = item.trim();
    if (!description) throw new Error(`第 ${index + 1} 条 Rubric 为空。`);
    return {
      id: `R${index + 1}`,
      name: `规则 ${index + 1}`,
      description,
      evidenceHints: [],
    };
  }

  if (item && typeof item === "object") {
    const entry = item as Partial<Rubric>;
    const description = String(entry.description || entry.name || "").trim();
    if (!description) throw new Error(`第 ${index + 1} 条 Rubric 缺少 description。`);
    return {
      id: String(entry.id || `R${index + 1}`),
      name: String(entry.name || `规则 ${index + 1}`),
      description,
      evidenceHints: Array.isArray(entry.evidenceHints) ? entry.evidenceHints.map(String) : [],
    };
  }

  throw new Error(`第 ${index + 1} 条 Rubric 格式不正确。`);
}

function summarizeManualFailReasons(task: Task, results: ScoreResult[]) {
  const summaries: string[] = [];
  const resultByUrl = new Map(results.map((result) => [result.url, result]));

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
