# Skill 评估指南

新建 skill、改变 description、调整核心工作流，或修复真实执行问题后读取本文。评估分为两类：

- 触发评估：description 是否在正确任务上加载 skill
- 输出评估：加载 skill 后是否比无 skill 或旧版本稳定地产出更好结果

`pnpm plugin:test` 和 `validate_plugin.js` 只验证确定性代码与结构合同，不能替代模型行为评估。

## 触发评估

只有允许模型自动发现的 skill 才需要把自动触发率作为验收门。固定 manual 的 skill 仍要保持 description 精确，但实际验收应确认它不会被自动调用、显式入口仍可用。

### 设计 query

准备约 20 条真实 query：

- 8–10 条 `should_trigger: true`
- 8–10 条 `should_trigger: false`
- 正例混合正式、口语、错别字、短请求和长上下文
- 正例包含没有直接说出领域名、但确实需要该 skill 的任务
- 负例优先使用共享关键词却需要相邻能力的 near miss
- 不要用天气、斐波那契等毫无重叠的简单负例

可保存为 `evals/trigger-queries.json`。这是本仓库的作者期约定，不是 Agent Skills runtime schema：

```json
[
  {
    "query": "帮我给现有插件加一个可重复运行的审查工作流",
    "should_trigger": true
  },
  {
    "query": "怎么安装 code-review 插件？",
    "should_trigger": false
  }
]
```

### 运行与优化

1. 确认 skill 已注册且客户端能观察是否加载 `SKILL.md`
2. 每条 query 在干净上下文中运行至少 3 次
3. 记录触发次数和 trigger rate
4. 建议以 0.5 为初始阈值：正例高于阈值、负例低于阈值
5. 将 query 固定拆成约 60% train 和 40% validation
6. 只根据 train 失败修改 description
7. 用 validation 选择泛化更好的版本
8. 最后再写 5–10 条未参与优化的新 query 做 sanity check

漏触发时扩大用户意图或场景类别；误触发时补相邻任务边界。不要直接把失败 query 的原词逐个追加到 description。

## 输出质量评估

### 用例格式

从 2–3 个真实任务开始。在 skill 内创建小型、可公开的 `evals/evals.json`：

```json
{
  "skill_name": "review-workflow",
  "evals": [
    {
      "id": 1,
      "prompt": "审查当前分支相对 main 的改动，只报告问题，不修改文件。",
      "expected_output": "按严重程度列出有证据的问题、测试缺口和总体结论。",
      "files": []
    }
  ]
}
```

要求：

- prompt 像真实用户输入，包含路径、上下文和自然表达
- 覆盖不同措辞和至少一个边界条件
- `expected_output` 描述成功，不固定无关文案
- `files` 只放小型、脱敏 fixture
- 大型或私有输入保存在 eval workspace，不提交到 skill

第一轮先不要固化 assertions。看过 current 与 baseline 的实际输出后，再把真正能区分质量且可以核验的断言加入对应 case。

AW 会复制声明的 skill 子树，因此不要把大型日志、仓库快照或敏感样本放进 `evals/`。

### 建立 baseline

每个 case 在干净上下文中至少运行两份：

1. `with_skill`：使用当前 skill
2. `without_skill`：不加载 skill

改进已有 skill 时，第二份改为冻结的 `old_skill`。所有配置使用相同 prompt、输入和输出目录规则，避免把会话历史带入下一次运行。

当前仓库没有统一的跨平台模型 eval runner。本轮只维护用例和证据格式；实际运行使用隔离会话或客户端现有的 agent/subagent 能力，不把 `pnpm plugin:test` 描述成模型评估入口。

### 断言和评分

先看第一轮实际输出，再补客观断言：

- 文件存在且格式有效
- 数量、字段或章节满足要求
- 报告引用了具体证据
- 没有执行禁止的写操作

避免“输出很好”这类不可验证断言，也避免要求完全相同措辞。可机械检查的断言用验证脚本；其余断言由 reviewer 或模型判分，但每个 PASS/FAIL 都必须给出文件、字段或文本证据。

将校准后的断言写回对应 case：

```json
"assertions": [
  "输出包含审查范围和总体结论",
  "每个问题包含位置、影响和可执行建议",
  "执行期间没有修改被审查文件"
]
```

除断言通过率外，同时记录：

- duration
- token 数量
- 失败或无效步骤的执行轨迹
- 人工反馈

Skill 增加的时间和 token 必须换来可辨认的质量提升。

## 迭代

每轮按以下顺序进行：

1. 运行 current 与 baseline
2. 对断言给出证据评分
3. 阅读人工反馈和完整执行轨迹
4. 找出模糊指令、无关步骤、缺失 gotcha 或重复脚本
5. 修改 skill，修复一般原因而不是单个 case
6. 在新 iteration 中重跑全部 case

如果两组都始终通过，删除没有区分度的断言；两组都始终失败时，先检查用例和能力边界；同一 case 结果波动大时，收紧模糊指令或增加短示例。

停止条件是反馈持续为空、关键断言稳定通过，或继续修改不再带来有意义提升。

## 完成检查

- [ ] 自动 skill 有正例和 near-miss 负例
- [ ] query 使用 train/validation，且多次运行
- [ ] 输出 eval 从 2–3 个真实任务开始
- [ ] current 与 baseline 使用相同输入和干净上下文
- [ ] 断言具体、可观察并带证据
- [ ] 机械断言优先使用脚本
- [ ] 同时查看 token、耗时、轨迹和人工反馈
- [ ] 修改解决一般原因，没有为单个 case 堆补丁

## 上游参考

- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
