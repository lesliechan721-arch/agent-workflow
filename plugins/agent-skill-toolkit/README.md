# agent-skill-toolkit

通用 Agent Skill 作者、单 Skill Review、跨 Skill 工作流 Review 和 Eval 设计/审核插件。

## 安装

先安装 Agent-facing 内容依赖，再安装本插件：

```bash
aw install agent-content-toolkit -p both
aw install agent-skill-toolkit -p both
```

只有需要实际运行模型 Eval 时，才需要另行安装兼容的 Eval runner；本插件只负责设计和审核 Eval。

## 包含的 Skill

| Skill | 作用 | 权限 |
| --- | --- | --- |
| `author-agent-skill` | 创建或变更一个 Agent Skill package | 写 |
| `review-agent-skill` | 只读评审一个 Agent Skill package | 只读 |
| `review-agent-workflow` | 只读评审有界的跨 Skill 工作流 | 只读 |
| `design-agent-skill-evals` | 创建或修改 Skill Eval case/suite | 写 |
| `audit-agent-skill-evals` | 运行前审核 Oracle，运行后归因结果 | 只读 |

## 典型用法

```text
创建一个用于整理 API 变更日志的 Agent Skill，并加入必要的 references 和确定性验证。
只读评审这个 Skill package 的触发边界、职责和资源组织。
评审由这三个 Skill 共同完成的发布说明工作流；入口是 changelog-router，排除真实发布。
为这个 Skill 设计 trigger、behavior 和 cost Eval，但不要运行 Eval。
```

## 边界

- 创建和 Eval 设计会写入用户指定的目标；Review 和 Audit 保持只读。
- 创建或变更不自动触发 Review、Audit 或模型 Eval。
- 单 Skill、跨 Skill 工作流和 AW 插件使用不同 Reviewer。跨组件工作流必须有明确用户结果、入口和参与组件；未界定系统先拆成 workflow。
- Eval Audit 不运行 Eval。实际运行需要用户授权、已固定的 Skill/corpus 和兼容 runner。
