# Human Content

将复杂需求、技术规格、架构设计、协议、代码机制或研究材料转化为人类容易理解、同时可查回原文的保真呈现。

## 安装

选择目标后安装：

```bash
aw target set codex claude
aw plugin install human-content --scope user
```

支持 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI、Grok Build 和通用导出目标 `generic`。如需直接导出所选目标的 Skills：

```bash
aw dev skill export human-content --scope user --out <dir>
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`explain-clearly`](skills/explain-clearly/README.md) | 面对复杂或晦涩的已有材料，需要按认知瓶颈转化为清晰受控短句（简化技术写作）、结构图/SVG、一次性离线交互 HTML 探索页或定制讲解视频，或把冗长需求改写清晰 |

## 典型用法

```text
这份计费降级和重试规格太绕了我看不懂。先用具体正反例子把流程讲透，画清状态和失败出口，并标出我还要拍板的风险与原文依据。
```

```text
把这份多主题设计规格做成单文件离线交互 HTML 写到 out/explainer.html，让我能单步演示状态变化、切换超时异常分支并点回原文条款；源文保持只读。
```

## 边界

- **专注理解，不替代决策、原型或审查**：不替用户批准方案，也不为尚未决定的界面或交互制作新产品候选；源码调查、生产前端开发、面向 Agent 的指令编写与独立质量审查均由对应直接方式或专门能力处理。
- **源文默认只读**：仅在明确要求直接改写原文可读性时才原位修改；本地生成的一次性 HTML 默认零外部网络、不启动反馈服务、不自动提交 Git。
- **视频先预检后制作**：制作定制讲解视频前，会先检查本机工具链、TTS 方案及潜在外部费用并取得确认。

公开入口：[explain-clearly](skills/explain-clearly/SKILL.md)。
