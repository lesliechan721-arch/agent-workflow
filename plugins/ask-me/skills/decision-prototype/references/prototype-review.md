# Prototype Review

只有需要标准网页反馈时读取本文件。简单文案、单张图片或无需局部定位的示例优先直接展示。

## 会话闭环

先生成 `brief.md`、`prototype.json` 和 `artifact/`。从 Skill 根运行：

```bash
node scripts/prototype-review.mjs start --prototype <prototype.json>
```

使用环境可用能力打开 receipt 中的 URL。脚本不会自动打开浏览器。然后运行：

```bash
node scripts/prototype-review.mjs wait --session <session.json> --timeout 30m
```

`submitted` 后读取 receipt 指向的 `feedback.json`。`timeout` 或 `cancelled` 后保留 Prototype，且不推断用户决定。不能保持阻塞命令时，使用以下只读命令重试：

```bash
node scripts/prototype-review.mjs status --session <session.json>
```

需要显式结束会话时运行：

```bash
node scripts/prototype-review.mjs stop --session <session.json>
```

命令参数、receipt 和退出码以 `node scripts/prototype-review.mjs --help` 及各子命令 `--help` 为准。

## Artifact 和标注

- 所有选项引用都必须位于 `artifact/`，并指向普通非符号链接文件。
- 静态 HTML 的关键元素使用 `data-prototype-id`。文本块和流程节点可再设置 `data-prototype-kind="text"` 或 `data-prototype-kind="node"`。
- 图片标注使用归一化坐标。
- 脚本型 HTML 使用不带 same-origin 权限的 sandbox。它不能使用 DOM 标注或 CSS 变量控制。
- 新 revision 不继承无法重新定位的旧标注。

会话只服务当前 Skill 的 Review Shell 和当前 Prototype 的 `artifact/`。它不服务 `brief.md`、`prototype.json`、`feedback.json` 或 Prototype 根中的其它文件。

## 反馈结果

- `accepted`：当前问题已有稳定结论。
- `revise`：读取具体反馈，修改 artifact，递增 revision，再启动新会话。
- `rejected`：当前候选空间不成立。
- `new-material-question`：先处理当前 Prototype 无法回答的新材料问题。

Prototype 目录最终只保留 `brief.md`、`prototype.json`、`artifact/`、`feedback.json` 和 `verdict.md`；不要创建 `review/`。
