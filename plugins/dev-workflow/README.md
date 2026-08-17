# Dev Workflow

用一组轻量、可组合的 Skill 组织中大型软件开发任务。

Dev Workflow 不要求每个任务都先写完备计划。它用 Spec 保存材料性共识，让实现阶段通过可变的纵向切片吸收新发现，并用独立 Review 检查规格与最终代码。需求澄清、决策访谈和可体验原型由 `ask-me` 提供。

## 安装

推荐同时安装 `ask-me`：

```bash
aw install ask-me -p both
aw install dev-workflow -p both
```

## 入口

显式使用 `/dev` 启动或继续结构化开发流程。熟悉各能力后，也可以直接调用专业 Skill。

## 本插件包含的 Skill

| Skill | 作用 |
| --- | --- |
| [`dev-workflow`](skills/dev-workflow/) | 用户入口；根据当前缺口选择一个最小能力 |
| [`dev-spec`](skills/dev-spec/) | 把已经形成的材料决定写成稳定 Spec |
| [`dev-review-spec`](skills/dev-review-spec/) | 审查 Spec 是否可批准、可实现、可验证且不过度规定 |
| [`dev-implement`](skills/dev-implement/) | 快速实现清楚的小任务，或按纵向切片实现 Spec |
| [`dev-review-code`](skills/dev-review-code/) | 分开审查 Spec 符合度和工程质量 |

## 与 `ask-me` 的组合

- 少量关键歧义 → `requirements-clarifier`
- 多项相互依赖决定 → `decision-grill`
- 必须看到、运行或操作候选结果才能决定 → `decision-prototype`

`dev-workflow` 不复制这些能力。缺少 `ask-me` 时，它会说明缺少的决策能力并停止在相应检查点。

## 典型路径

### 小任务

```text
明确请求 → dev-implement → 针对性验证
```

不创建 Spec，也不为了流程本身增加文档。

### 中型任务

```text
ask-me → dev-spec → dev-review-spec → 用户批准 → dev-implement → dev-review-code
```

### 需要体验反馈

```text
decision-prototype → 用户反馈 → dev-spec → review → implement
```

## 设计边界

- Spec 保存用户行为、范围、公共契约、数据、安全、风险和验收等材料决定。
- 文件拆分、局部算法、测试组织和临时任务顺序留给实现阶段。
- `work.md` 只在跨会话、多切片、迁移或 handoff 能降低成本时创建；它不是用户批准合同。
- Review 规定检查结果，不规定阅读顺序、工具或子代理数量。
- 插件不内置需求访谈、原型制作、Git、worktree、commit、发布或持久状态引擎；需要时组合其它能力。

## 用户检查点

工作流只在确有必要时停下来：

- 材料决定
- 原型反馈
- Spec 批准
- 高风险或不可逆动作授权

## 维护者

```bash
pnpm plugin:test dev-workflow
```

每个 Skill 的触发用例位于自身 `evals/`。新插件首版只提供 author-period trigger corpus；真实模型行为证据需要在合并前按仓库 Eval 流程显式运行。
