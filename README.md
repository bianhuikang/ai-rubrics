# AI Rubrics Judge

本工具用于基于一个需求 prompt 和多个网页产物 URL，自动生成中等粒度 rubrics，并对每个网页产物逐条输出 0/1 评分矩阵。

## 技术栈

- Next.js：配置页、任务页、Rubrics 编辑、评分结果展示
- SQLite：保存模型配置、任务、rubrics、评分结果
- Playwright：打开网页产物，采集 DOM、文本、截图、布局和交互证据
- OpenAI-compatible / Claude API：生成 rubrics 和执行最终 0/1 判断

## 启动

```bash
npm install
npm run install:browsers
npm run dev
```

打开 `http://localhost:3000`。

如果你已经手动安装过依赖，但 Next 构建提示内部模块缺失，建议删除 `node_modules` 和 `package-lock.json` 后重新执行上面的安装命令。

## 使用流程

1. 点击右上角“配置”设置模型：
   - `OpenAI Chat Completions 格式`：请求体按 OpenAI chat completions 格式发送。
   - `Anthropic Messages 格式`：请求体按 Anthropic messages 格式发送。
   - 接口地址填什么就请求什么，不自动拼路径，也不限制 URL 结尾。
2. 左侧新建任务：粘贴甲方给的任务 ID、需求 prompt、产物 URL 数组。
3. 点击“创建并执行”，任务会进入中间任务表并自动执行。
4. 工具会自动：
   - 先抓取所有候选产物证据
   - 基于需求和候选差异生成 5-12 条 rubrics
   - 再逐个 URL：
   - 用 Playwright 抓 DOM、文本、截图、布局、canvas/svg/图片、脚本库、动画和移动端响应式证据
   - 执行通用鼠标/按钮探针，以及命中文档编辑器类需求时的专项交互探针
   - 调用模型逐 rubric 输出 0/1
5. 中间任务表会展示状态、已完成 URL 数和进度。
6. 右侧结果区查看当前任务的矩阵、rubrics、理由、截图和交互探针结果。
7. 用 JSON/CSV 按钮导出结果。

产物 URL 支持两种粘贴方式：

```json
["https://example.com/a/index.html", "https://example.com/b/index.html"]
```

或者一行一个 URL。

## Rubrics 设计原则

默认提示词会要求模型生成“中等粒度”规则：

- 不生成“是否完成需求”这种太粗的规则。
- 不把每个普通 DOM 节点拆成单独规则。
- 每条 rubric 必须能用 0/1 判定。
- 数量按复杂度自适应：单一动画/小游戏/简单可视化通常 5-7 条；复杂站点、编辑器、游戏和数据可视化通常 8-12 条。
- 优先覆盖显式技术栈/库/API、硬性 ID/class、页面结构、指定内容或数据、核心视觉渲染、关键交互、状态反馈、响应式。
- 对 Canvas、SVG、3D、动画、游戏、数据可视化类需求，会覆盖核心画面、动态变化、控制项和规则/状态反馈，而不是只看静态文字。

## 数据位置

- SQLite 数据库：`data/app.db`
- 页面截图：`public/screenshots/<taskId>/`

这些路径已经写入 `.gitignore`。

## 常用命令

```bash
npm run typecheck
npm run build
npm run dev
```
