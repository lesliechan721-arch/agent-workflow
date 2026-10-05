# Human Content

提供面向人的复杂材料阅读与反馈能力。`explain-for-review` 把已有内容转成保真、可查证的呈现，按实际需要选择文字、图表或交互页面。

安装到 Codex 和 Claude Code：

```bash
aw install human-content -p both
```

例如：

```text
使用 explain-for-review 解释这份规格，让我看清待决定事项和主要风险，并能查到原文。需要长文导航时，将本地阅读页写到 out/；源文保持只读。
```

本插件可独立用于方案、协议、研究说明和审查报告，也可被设计工作流调用。它不接管产品决定、规范编写或独立审查；派生视图不是第二份事实源。默认采用低成本且本地的形式，外部服务、发布和音视频生成依当前明确请求、工具及授权。

公开入口：[explain-for-review](skills/explain-for-review/SKILL.md)。
