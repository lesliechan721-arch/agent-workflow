# Dev Workflow

用一组轻量、可组合的 Skill 组织中大型软件开发任务。

Dev Workflow 不要求每个任务都先写完备计划。它帮助用户和 Agent 保存材料性共识，用 Prototype 解决难以只靠文字决定的问题，用 Spec 记录稳定决定，再让实现阶段通过可变的纵向切片吸收新发现。

## 安装

推荐同时安装 `ask-me`，用于局部需求澄清和多轮决策访谈：

```bash
aw install ask-me -p both
aw install dev-workflow -p both
```

## 入口

显式使用 `/dev` 启动或继续结构化开发流程。熟悉各能力后，也可以直接调用专业 Skill。

## 包含的 Skill

| Skill | 作用 |
| --- | --- |
| [`dev-workflow`](skills/dev-workflow/) | 用户入口；根据当前缺口选择一个最小能力 |
| [`dev-prototype`](skills/dev-prototype/) | 制作回答单一设计问题的可体验原型 |
| [`dev-spec`](skills/dev-spec/) | 把已经形成的材料决定写成稳定 Spec |
| [`dev-review-spec`](skills/dev-review-spec/) | 审查 Spec 是否可批准、可实现、可验证且不过度规定 |
| [`dev-implement`](skills/dev-implement/) | 快速实现清楚的小任务，或按纵向切片实现 Spec |
| [`dev-review-code`](skills/dev-review-code/) | 分开审查 Spec 符合度和工程质量 |

需求对齐由 `ask-me` 提供：

- 少量关键歧义 → `requirements-clarifier`
- 多项相互依赖决定 → `decision-grill`

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
ask-me → dev-prototype → 用户反馈 → dev-spec → review → implement
```

## 设计边界

- Spec 保存用户行为、范围、公共契约、数据、安全、风险和验收等材料决定。
- 文件拆分、局部算法、测试组织和临时任务顺序留给实现阶段。
- `work.md` 只在跨会话、多切片、迁移或 handoff 能降低成本时创建；它不是用户批准合同。
- Review 规定检查结果，不规定阅读顺序、工具或子代理数量。
- 插件不内置 Git、worktree、commit、发布或持久状态引擎；需要时组合项目现有能力。

## 用户检查点

工作流只在确有必要时停下来：

- 材料决定
- Prototype 反馈
- Spec 批准
- 高风险或不可逆动作授权

## 维护者

```bash
pnpm plugin:test dev-workflow
```

每个 Skill 的触发用例位于自身 `evals/`。新插件首版只提供 author-period trigger corpus；真实模型行为证据需要在合并前按仓库 Eval 流程显式运行。
