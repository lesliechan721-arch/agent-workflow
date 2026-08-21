# Agent Content Toolkit

用于创建和评审给 Agent 直接读取的内容。该插件只拥有 Agent-facing 文档能力；完整 Agent Skill 与 Skill Eval 由 `agent-skill-toolkit` 提供。

## 安装

```bash
aw install agent-content-toolkit -p both
```

## 包含的 Skill

| Skill | 作用 | 写入 |
| --- | --- | --- |
| [`write-agent-content`](skills/write-agent-content/) | 创建或编辑 `AGENTS.md`、`CLAUDE.md`、prompt、role instruction 和 reference | 是 |
| [`review-agent-content`](skills/review-agent-content/) | 只读评审指针、信息层级、最小控制、完成边界和可维护性 | 否 |

## 设计边界

- 每次只加载当前内容任务需要的 Skill 和规则投影。
- Author 可以修改目标，Reviewer 保持只读。
- 大 reference 的尺寸只触发语义审计；是否拆分取决于职责、branch locality 和 active-path load。
- 机械合同检查交给脚本，语义判断保留给模型和 Reviewer。
- Agent Skill 包、Eval、发布和项目插件生命周期不在本插件中实现。

## 维护者

当前插件合同版本：`0.6.0`。

`standards/rules.json` 只维护 Agent-facing 内容层规则。生成视图和 Skill-local 合同只在 staging/runtime 中生成或投影。检查合同：

```bash
pnpm plugin:test agent-content-toolkit
```
