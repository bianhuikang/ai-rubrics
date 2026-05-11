# AI Rubrics Feishu Sync

Chrome MV3 插件，用来把 AI Rubrics Judge 的任务结果同步到飞书在线表格/多维表格的当前记录卡片。

## 安装

1. 打开 Chrome 扩展程序页面。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：

`chrome-extension`

插件文件现在直接放在 `chrome-extension` 目录下，不再有 `feishu-ai-rubrics-sync` 子目录。

## 使用

1. 打开飞书记录卡片。
2. 插件会从卡片标题 `.bitable-card-modal-header-v2-title-content` 提取任务 ID。
3. 点击“同步当前记录”。
4. 插件调用后端接口：`GET /api/tasks/:id/sync-summary`。
5. 如果任务未完成，接口返回 `任务未完成`，插件不写入表格。
6. 如果任务完成，插件写入评分和备注；当后端标记 `rubricsModified=true` 时，也会尝试覆盖 rubrics。

## 当前字段定位

飞书卡片字段按 `data-field-id` 精确定位：

- rubrics: `fldRoIVLrj`
- 评分: `fldw5fV0zW`
- 备注: `fld78Lhbjz`

如果飞书表格复制了一份或字段重新创建过，字段 ID 可能会变，需要更新 `content-script.js` 里的 `FIELD_ID_BY_NAME`。

## 注意

飞书富文本编辑器背后有自己的状态管理。评分和备注写入相对稳定；rubrics 是长富文本，自动覆盖可能有视觉闪动或编辑态显示异常，但以后端保存结果为准。

调试时打开页面 DevTools Console，搜索：

`[ai-rubrics-sync]`
