---
name: dev-workflow
description: 当用户明确要求使用结构化开发流程、启动或继续跨步骤开发任务，或已有决策记录、Prototype、Spec、Review、work、diff、branch 或 PR 需要按风险和当前阶段选择下一步时使用。负责选择保障等级并编排专业能力；普通明确的小改动且用户未要求工作流时不要使用。
---

# Dev Workflow

你是开发流程入口。先选择最低但足够的保障等级，再从当前最早未完成阶段继续。跨 Skill 编排只由本 Skill 负责；专业 Skill 只完成自己的任务并返回结果。

## 1. 建立任务上下文

读取用户目标、仓库约定和已有 artifact：决策记录、Prototype 记录、Spec、Spec Review、`work.md`、diff、branch、PR、Code Review 和验证证据。

能从代码、配置、文档或工具查明的事实直接调查。不要把事实缺口升级成用户决策，也不要把局部工程选择升级成材料决定。

## 2. 选择保障等级

选择最低但足够的等级；出现更高风险信号时升级。

### Fast

适用于同时满足：请求明确、范围小、可逆、预计一个上下文完成、存在可靠验证，且不涉及公共契约、持久数据、安全边界或高风险副作用。

路径：`dev-implement` → 针对性验证；只有风险或改动面需要时再做 `dev-review-code`。不为流程本身创建文档。

### Standard

适用于中等范围、改变用户可观察行为、跨多个模块、存在材料决定、需要 Prototype、可能跨会话或需要正式 Review 的任务。

路径：决策循环 → `dev-spec` → `dev-review-spec` → 用户批准 → `dev-implement` → `dev-review-code`。

### Assured

适用于安全、权限、支付、持久数据、迁移、生产副作用、不可逆操作、多 Agent 并发、较大 blast radius 或缺少可靠自动化测试的任务。

沿用 Standard 路径，并要求与项目风险相称的持久证据、回滚点、隔离工作区、明确授权和独立最终 Review。不要把这些保障复制成新的自然语言状态机；使用项目已有工具、策略和运行时。

## 3. 确定任务目录

优先使用用户指定路径或仓库现有约定。Standard 和 Assured 都没有约定时，使用：

```text
docs/dev/<task-slug>/
```

其中 `<task-slug>` 为稳定的 kebab-case 名称。文件按需出现：

```text
decisions.md
prototypes/<decision-id>/brief.md
spec.md
spec-review.md
work.md
code-review.md
```

任务目录只确定一次，并传给后续能力；专业 Skill 不自行发明另一套路径。

## 4. 判断当前阶段

从最早未完成阶段继续，一次只选择一个当前能力。

### 新请求或决策阶段

- 相互依赖的材料决定可以通过讨论和取舍解决：`decision-grill`。
- 必须通过体验、实验、测量或运行结果才能解决：`decision-prototype`。
- 可调查事实：先调查，再重新判断。
- 局部工程选择：留给实现阶段。
- 材料决定已经稳定：`dev-spec`。

### 消费决策结果

`decision-grill` 返回：

- 有“需要证据才能决定” → `decision-prototype`。
- 仍有未解决材料决定 → 继续决策阶段。
- 材料决定稳定 → `dev-spec`。

`decision-prototype` 返回：

- 有新的相互依赖材料问题 → `decision-grill`。
- 仍需另一个独立证据问题 → `decision-prototype`。
- 决定稳定 → `dev-spec`。

Prototype 的稳定结论进入 Spec 的规范性章节；完整 Prototype、用户反馈、被否决方案和实验过程只作为 Evidence 链接。

### Spec 阶段

- 没有 Spec：`dev-spec`。
- 用户要求修改现有 Spec：`dev-spec`。
- Spec 草案尚未审查：`dev-review-spec`。
- Spec Review 为 `blocked`：按处理类型路由：
  - `material-decision` → `decision-grill`
  - `evidence-needed` → `decision-prototype`
  - `spec-defect` 或 `over-specified` → `dev-spec`
  - `fact-gap` → 调查事实后重新审查
  - `mechanical-validation` → 运行脚本、测试或项目工具后重新审查
- Spec Review 为 `clean` 但尚未批准：展示摘要并请求用户明确批准。
- Spec 已批准：`dev-implement`。

### 实现阶段

- 已有 `work.md`：`dev-implement` 继续当前纵向切片。
- 实施发现 `material-decision` 或 `evidence-needed`：回到决策阶段。
- 实施发现 `spec-change`：更新 Spec，重新 Review 和批准。
- 实现完成并有验证证据：`dev-review-code`；Fast 任务可按风险省略独立 Review。

### Code Review 阶段

- `implementation-defect` 或 `spec-fidelity` blocker → `dev-implement`。
- `spec-defect` → `dev-spec`，然后重新 Review 和批准。
- `material-decision` → `decision-grill`。
- `evidence-needed` → `decision-prototype`。
- `clean` → 交付摘要；不再创建新的交付 Skill。

## 5. 人类检查点

只在以下情况暂停：

- 材料决定需要用户承担取舍；
- Prototype 需要用户观察或操作反馈；
- Standard/Assured Spec 需要明确批准；
- 高风险、破坏性、远程、凭据、显著成本或不可逆动作需要授权。

用户原始请求已经明确授权后续非人类阶段时，可在检查点之间继续推进。

## 输出

在每次路由时简要说明：

```text
保障等级：Fast / Standard / Assured
当前阶段：<阶段>
任务目录：<路径 / 无>
路径：<当前能力或阶段序列>
原因：<关键风险或缺口>
人类检查点：<无 / 材料决定 / 原型反馈 / Spec 批准 / 高风险授权>
```

选择能力后加载并执行它，而不是只返回能力清单。
