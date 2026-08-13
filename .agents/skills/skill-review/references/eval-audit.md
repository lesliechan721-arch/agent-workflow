# Eval Case Audit

只在被审 Skill 含 eval，或 eval 结果将用于评分、发布或修改 Skill 时读取本文件。

目标不是要求所有 case 都通过。目标是判断：

1. eval 是否有资格评价 Skill；
2. eval 结果是否足以驱动修改；
3. 修改后的净收益是否高于回归、上下文和维护成本。

不要把 eval 文件、case 数量或一个总体通过率直接当作发布证据。

## 当前仓库合同

本审计层补充现有可执行 eval 合同，不替换它：

- `evals/manifest.json` 继续定义 suite、participant、`defaultRuns`、发布 split 和执行隔离。
- 可执行 trigger split 仍是 `train`、`validation` 和 `sanity`。`regression`、`boundary`、`challenge`、`diagnostic` 是 case role，不是新的 runner split。
- `manifest.suites[].kind` 是执行入口。`eval_type` 是本审计使用的决策层。一个 trigger suite 中的相邻 Skill 竞争 case 可以把 `eval_type` 标为 `routing`。
- trigger 的机械期望仍使用 `should_load_skill` 或 `expected_loaded_skills`。conversation 的机械和定性断言仍使用 `review.artifacts` 与 `review.checks`。
- audit metadata 可以作为额外字段放入现有 case 文档。当前 runner 忽略这些字段，`scripts/validate_eval_cases.mjs` 读取它们。
- 实际运行次数以 manifest 和运行报告为准。case 内的 `run_policy` 只说明扩样决策，不能覆盖 manifest。
- conversation baseline 会移除 owner Skill，但保留 companion Skills。纯 trigger eval 不强制使用无 Skill baseline；改动 description 时应比较上一版或固定 validation/sanity。

历史 case 可以渐进迁移。缺少 metadata 时，先把 oracle 置信度或门禁标为 `unknown`。不要把缺少 metadata 自动升级为 P0/P1。会进入 train、validation、sanity、regression、发布判断或当前修改的 case，必须先完成下面的 Case Admission 检查。

## 审计结构

Eval Audit 只使用 `evals` 一个评分维度，但分两个阶段：

### 阶段 A：Suite Validity

检查目标、错误代价、测试层级、oracle、现实性和覆盖。对应门禁：

- `eval-validity`

### 阶段 B：Result Decision

检查实际运行、统计不确定性、失败归因和修改安全。对应门禁：

- `release-evidence`：沿用主评分模型中的门禁；
- `eval-change-safety`：仅在 eval 已驱动或准备驱动当前 Skill 修改时适用。

先完成阶段 A，再用运行结果评价 Skill。

## 优化目标和错误代价

正例与负例数量接近，只表示两个方向都有样本，不表示 false negative 和 false positive 的代价相等。

对有正负决策的 suite 声明策略：

- `recall-first`：漏触发或漏拦截的代价明显更高；
- `precision-first`：误触发或误拦截的代价明显更高；
- `balanced`：两类错误的影响接近；
- `critical`：存在不能由平均分抵消的关键场景。

至少记录：

| 项目 | 内容 |
| --- | --- |
| False-negative cost | low / medium / high / critical，以及原因 |
| False-positive cost | low / medium / high / critical，以及原因 |
| Optimization policy | recall-first / precision-first / balanced / critical |
| 适用场景 | 哪些实际任务承担该代价 |

对 trigger 或其它二元决策分别报告：

- positive recall；
- false-negative rate；
- negative specificity；
- false-positive rate。

不要只报告一个总准确率。实际场景频率未知时，不生成伪精确加权分数。说明不同错误代价政策是否会改变结论。

## Case Admission 检查

### 1. Test layer

每个 assertion 只选择一个主层级：

- `trigger`：是否加载 Skill；
- `gate`：加载后业务 Gate 是否通过；
- `routing`：Skill、role、模型、上下文或工具参数是否正确；
- `behavior`：执行过程是否遵守关键不变量；
- `outcome`：最终产物、文件或仓库状态是否正确；
- `cost`：token、时间、工具次数和上下文成本。

同一 fixture 可以支持多个 case，但一个 assertion 不得混合多个决策层。纯 trigger case 不同时断言 spawn、routing 或最终 outcome。

### 2. Unit under test

明确测试对象：description、正文规则、script、role、runtime/client，或完整 Skill 包。

### 3. Preconditions

列出会改变 oracle 的必要前提，例如：

- 文件、仓库规模和材料范围；
- 工具、schema、权限和客户端能力；
- 用户上下文或适用项目规则；
- 目标 Skill 与相邻 Skill 是否存在；
- baseline 或上一版本。

前提不足时，不使用绝对布尔标签断言后续行为。补 fixture、拆分层级，或把 case 标为 conditional。

### 4. Oracle rationale

说明为什么预期结果正确，并绑定以下至少一种依据：

- Skill 目标；
- 具体规则；
- observed failure；
- normative requirement；
- 可直接验证的 structural relation。

仅凭 reviewer 直觉或第三方 heuristic，不能成为 train、validation、sanity 或 regression 的高置信 oracle。

### 5. Observable assertions

断言必须能从输出、工具 trace、文件或仓库状态判定。机械事实优先使用脚本。不要以模型是否复述术语代替行为检查。

### 6. Allowed variance

说明哪些不同实现仍然正确。不要把固定措辞、步骤顺序或单一策略当作唯一正确答案。

### 7. Minimal counterexample

指出只改变哪个决定性条件后，标签应翻转。重要触发边界至少有一个 minimal pair。

### 8. Oracle confidence

使用 `high`、`medium` 或 `low`。低置信 case 只能作为 challenge、diagnostic 或待裁决样本，不能单独驱动发布和修改。

## 现实性与普适性

### Provenance

每个关键 case 标记来源：

- `observed`：真实用户请求、trace 或实际失败；
- `derived`：从真实案例得到的自然变体；
- `representative-synthetic`：人工构造，但代表清楚的现实场景族；
- `boundary`：验证标签翻转边界；
- `challenge`：极端、对抗或罕见组合；
- `mechanism-probe`：为隔离一个机制而构造。

### Case role

每个关键 case 标记用途：

- `representative`：代表常见或核心承诺场景；
- `regression`：来自已观察失败；
- `boundary`：验证相邻决策边界；
- `challenge`：压力测试；
- `diagnostic`：帮助定位原因，不进入发布指标。

发布判断应主要由 representative 和 regression 场景支持。Challenge、diagnostic 或 mechanism-probe 失败不能自动驱动通用 Skill 增加规则。

### Scenario family

每个关键 case 归属一个场景族。报告同时统计：

- case 数；
- scenario-family 数；
- decision-boundary 或 minimal-pair 数。

同义改写可以测试语言鲁棒性，但不能冒充多个独立场景。prompt 应像真实用户请求，不把预期机制、规则名或答案写入输入。

## Suite Composition

可用于发布的 suite 通常覆盖：

- 核心正场景；
- 核心负场景；
- 高价值 near-miss；
- 重要 minimal pair；
- observed regression；
- 少量 boundary/challenge；
- 相邻 Skill 竞争场景；
- 不同措辞、显式程度、上下文量和任务复杂度。

数量平衡不表示决策权重相等。不要通过重复近义 query 放大一个场景族。Challenge 和 diagnostic case 必须从发布指标中分离，或位于不参与发布的 suite/split。

## 运行与统计解释

三次运行只作为初始取样，不是通用发布阈值。

| 初始结果 | 默认动作 |
| --- | --- |
| 0/3 或 3/3，且影响低 | 暂时接受，记录样本小 |
| 1/3 或 2/3 | 标记 uncertain，增加运行并读取 trace |
| 高影响或 critical case | 即使首轮一致，也增加运行 |
| 新旧版本差异小 | 使用 paired runs，不宣称改善 |
| 接近发布阈值 | 增加运行，直到结论稳定或标记 unknown |

混合结果首先表示证据不足，不能直接生成 Skill 修改。9/10 也不是自动缺陷。是否处理取决于错误代价、代表性、baseline、trace 和修复回归风险。

行为、outcome 和 cost eval 至少比较一个适用 baseline：

- without-owner-skill；
- minimal-skill；
- previous-version。

记录质量、token、时间和运行方差。纯 trigger suite 可以用固定 negative/positive split 与 previous-version 比较，不要求没有实际信息增量的 without-skill baseline。没有实际运行记录时，eval 文件只能支持测试设计评价，不能充当 observed behavior evidence。

## Eval Failure Triage

每个失败先归类，再决定动作：

- `skill-defect`
- `oracle-defect`
- `fixture-defect`
- `grader-defect`
- `runtime-or-tool-defect`
- `model-variance`
- `stale-case`
- `insufficient-runs`
- `expected-tradeoff`
- `unknown`

只有 `skill-defect` 可以进入 Skill 修改候选。

归类前检查：

1. oracle 是否仍符合当前 Skill 版本；
2. fixture 和前提是否充分；
3. case 是否混合测试层级；
4. grader 是否真正检查目标；
5. 失败是否可复现；
6. runtime/client 是否改变能力；
7. 是否属于声明的代价取舍。

## Eval-driven Change Gate

由 eval 驱动的修改只有同时满足以下条件才接受：

1. case 通过 Case Admission 检查；
2. case 是 representative、regression，或现实可达且高影响的关键场景；
3. 失败被归因为 `skill-defect`；
4. 失败可复现，或 trace 提供清楚因果；
5. 修复面向场景族，不面向一个具体 query；
6. 修复没有把 heuristic 直接升级为新的硬规则；
7. 修复后重跑原 case、同族变体、minimal pair、相反标签 near-miss、固定 validation/sanity 和关键 regression；
8. 记录 Skill 文本、branch、token、时间和维护复杂度变化；
9. 净收益高于新增回归和复杂度成本。

默认改进顺序：

`fix eval/fixture → collect more evidence → delete/relax Skill rule → replace/merge rule → add new rule`

不要把每个 eval failure 自动转换成 Skill 补丁。

## 三个门禁

### `eval-validity`

- **Pass**：关键 case 的层级、前提、oracle、assertion、场景族和版本关系清楚；没有已知错误标签。
- **Unknown**：只有输入和标签，缺少 rationale、rule refs、前提、case role，或现实性不能确认。
- **Fail**：关键 case 与 Skill 目标直接矛盾；混合决策层；或已知错误 oracle 仍驱动评分和修改。
- **Not applicable**：目标没有 eval，且没有 eval 结果用于当前判断。

`eval-validity=fail` 时，先修复、重新裁决或移除错误 case。当前 suite 不得继续驱动 Skill 修改。

### `release-evidence`

沿用主评分模型。对 eval 至少检查真实运行、适用 baseline、重复运行、trace、质量与成本结果。未执行的 eval 不构成发布行为证据。

### `eval-change-safety`

只在当前修改已由 eval 驱动，或准备由 eval 结果驱动时适用。

- **Pass**：失败完成归因，修复经过相邻边界和固定 validation/sanity/regression 回归。
- **Unknown**：知道修改来自 eval，但没有完整回归或复杂度 delta。
- **Fail**：单一、低置信或不现实 case 直接导致规则增加；修复目标 case 却伤害更高价值场景；或错误 oracle 已造成设计漂移。
- **Not applicable**：当前没有 eval-driven 修改。

## `evals` 维度评分锚点

### 5 — 发布级

- 三个适用门禁均通过；
- 错误代价和优化策略清楚；
- 关键 oracle、现实性和场景族可靠；
- 有 representative/regression 运行、适用 baseline、trace 和成本结果；
- eval-driven 修改通过 change-safety 回归。

### 4 — 可靠迭代级

- Suite 设计与 oracle 可靠；
- 已有实际运行和主要 baseline；
- 只有少量非关键覆盖、方差或 change-safety 缺口。

### 3 — 诊断级

- Case 设计大体合理，可用于发现问题；
- 实际运行、代表性、错误代价或 baseline 不足；
- 不能单独支持发布判断。

### 2 — 高漂移风险

- 大量 case 缺少 oracle rationale、场景族或必要前提；
- trigger、Gate、routing 和 outcome 混层；
- 少量或混合运行结果直接驱动修改；
- challenge 或精心构造用例主导结论。

### 1 — 误导性

- 已知错误标签、失效 grader 或不现实 fixture 仍用于 train/regression；
- 修复明显针对一个 query 过拟合；
- 错误代价被错误地视为等价。

### 0 — 不可使用

- Eval suite 系统性把 Skill 推离其目标；
- oracle、grader 或 fixture 已知失真，但仍作为发布门禁。

## 评分上限

- 只有 eval 文件，没有 Case Admission Audit：`evals` 通常不高于 2。
- Case 设计已审计但没有实际运行：通常不高于 3。
- 有运行但没有适用 baseline、方差解释、错误代价政策或 failure triage：通常不高于 4。
- 已知错误 oracle 仍驱动当前修改：通常不高于 1，并使 `eval-validity=fail`。

## Validator 边界

运行：

```bash
node scripts/validate_eval_cases.mjs <eval-cases.json> --format json
```

默认模式保持历史语料兼容：确定性矛盾为 error，缺少发布级 audit metadata 为 warning。只对已经选定为发布级或修改依据的 case 文档使用 `--strict`。

Validator 只能检查结构、枚举、重复 ID、层级混合和 metadata 缺口。它不能判断 oracle 的语义是否正确，也不能代替 trace 复核、failure triage 或三个门禁。

## 停止条件

当以下条件成立时停止继续扩写 eval 或 Skill：

- 关键 oracle 已确认；
- 代表性场景和主要边界已覆盖；
- 混合结果已标为 uncertain，或已有足够运行；
- 没有证据支持新的 `skill-defect`；
- 新增 case 或规则只会重复场景族、扩大维护成本或提高过拟合风险。
