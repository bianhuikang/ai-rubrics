# 使用说明

## 最简步骤

1. 安装依赖：

```bash
npm install
npm run install:browsers
```

2. 启动应用：

```bash
npm run dev
```

3. 打开页面：

```text
http://localhost:3000
```

4. 点击右上角“配置”，新增或选择一个模型配置，填写：

- API 格式
- 完整接口地址
- API Key
- Model

5. 点击“测试连接”，成功后点击“保存”。

6. 左侧新建任务，填写：

- 任务 ID
- Prompt
- 产物 URL 数组

URL 支持 JSON 数组：

```json
["https://example.com/a", "https://example.com/b"]
```

也支持一行一个 URL。

7. 点击“创建并执行”。

8. 右侧先显示执行过程日志，全部评分完成后显示 Rubrics 和打分结果。

9. 需要导出时，点击结果区右上角的 `JSON` 或 `CSV`。

## 常用命令

```bash
npm run dev
npm run typecheck
npm run build
```
