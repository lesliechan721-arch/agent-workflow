# Dev Workflow

按任务风险和当前阶段组织软件开发工作，而不是对所有需求套用同一套流程。

Dev Workflow 先选择 Fast、Standard 或 Assured 保障等级，再从最早未完成阶段继续。专业 Skill 只完成自己的工作并返回结果；跨 Skill 编排集中在 `dev-workflow`。

## 安装

```bash
aw install dev-workflow -p both
```

安装集合应同时提供工作流需要组合的决策能力，例如 `decision-grill` 和 `decision-prototype`。

## 入口

显式使用 `dev-workflow` 启动或继续结构化开发流程。熟悉各能力后，也可以直接调用专业 Skill。

## 本插件包含的 Skill

| Skill                                        | 作用                                             |
| -------------------------------------------- | ------------------------------------------------ |
| [`dev-workflow`](skills/dev-workflow/)       | 入口；选择保障等级并从当前最早未完成阶段继续     |
| [`dev-spec`](skills/dev-spec/)               | 把已经形成的材料决定写成稳定 Spec                |
| [`dev-review-spec`](skills/dev-review-spec/) | 审查 Spec 是否可批准、可实现、可验证且不过度规定 |
| [`dev-implement`](skills/dev-implement/)     | 实现明确请求或已批准 Spec，并保存必要工作记忆    |
| [`dev-review-code`](skills/dev-review-code/) | 分开审查 Spec 符合度和工程质量                   |

## 保障等级

| 等级 | 适用范围 | 典型路径 |
| ---- | -------- | -------- |
| Fast | 明确、低风险、可逆、一个上下文可完成且有可靠验证 | 实现 → 针对性验证；按需代码审查 |
| Standard | 中等范围、改变用户行为、跨模块、存在材料决定或需要跨会话 | 决策 → Spec → Spec Review → 批准 → 实现 → Code Review |
| Assured | 安全、权限、支付、数据迁移、生产副作用、不可逆、多 Agent 或缺少可靠测试 | Standard 路径，加持久证据、回滚点、明确授权和独立最终审查 |

## 默认开发文档目录

优先遵循用户路径或仓库现有约定。Standard 和 Assured 任务都没有约定时，使用：

```text
docs/dev/<task-slug>/
├── decisions.md
├── prototypes/
│   └── <decision-id>/
│       ├── brief.md
│       └── <原型产物>
├── spec.md
├── spec-review.md
├── work.md
└── code-review.md
```

文件按需创建。Fast 路径不为流程本身创建文档。

## 阶段路由

- 可通过讨论解决的材料决定 → `decision-grill`
- 必须通过体验、实验、测量或运行结果解决的决定 → `decision-prototype`
- 材料决定稳定但没有 Spec → `dev-spec`
- 已有 Spec 草案、尚未审查 → `dev-review-spec`
- Spec clean 但尚未批准 → 请求用户批准
- 已批准或走 Fast 路径 → `dev-implement`
- 已有完成实现、diff、branch 或 PR → `dev-review-code`

Review 和实施结果使用中性处理类型描述阻塞。只有入口负责把 `material-decision`、`evidence-needed`、`spec-defect`、`implementation-defect` 等类型映射回下一阶段。

## 设计边界

- Spec 保存用户行为、范围、公共契约、数据、安全、风险和验收等材料决定。
- Prototype 的稳定结论进入 Spec 规范性章节；完整原型、用户反馈和被否决方案只作为 Evidence 链接。
- 文件拆分、局部算法、测试组织和临时任务顺序留给实现阶段。
- `work.md` 只在跨会话、多切片、迁移或 handoff 能降低成本时创建；它不是用户批准合同。
- 专业 Skill 不直接调用其它 Skill，也不处理依赖缺失。
- Git、worktree、commit、发布、权限和持久状态由项目现有工具与运行时保证。

## 用户检查点

工作流只在确有必要时停下来：材料决定、原型反馈、Spec 批准、高风险或不可逆动作授权。
