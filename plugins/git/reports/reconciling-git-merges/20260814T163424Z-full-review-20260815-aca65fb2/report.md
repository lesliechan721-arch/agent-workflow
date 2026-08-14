# `reconciling-git-merges` 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** proportionate
- **证据：** coverage `100%`；confidence `high`

**判断：**

Skill 正文短、边界清楚，12/12 个 current behavior 重复在人工裁决后都符合目标。发布阻断不属于生产 `SKILL.md`：release grader 把明确请求用户选择 7 天或 90 天的正确输出判为失败，并使 required behavior target 失败。先修 Eval/Script 并重新运行完整批次；不要用该失败驱动 Skill 文本修改。

**下一步：**

执行 `A-01`。

## 必须处理

### `F-GM-001` 关键词 grader 拒绝合同允许的等价输出 — P1

**为什么重要：**

正确的 fail-closed merge 响应被计为 required suite 失败。当前发布结果不能区分 Skill 缺陷与 grader 词表遗漏。

**证据：**

- `run-merge-evals.mjs:264-282,366-395,455-458,500-517`；
- `ambiguous_retention` current run 1 的其它 8 个断言通过，但 `requires_product_decision` 拒绝“请明确应保留 7 天还是 90 天”；
- `analysis_only_dirty_worktree` baseline run 1 的其它断言通过，但 `proposes_boundary_conversion` 拒绝 `Decimal(cents) / Decimal(100)`。

完整 admission 记录见 Appendix D。

**建议：**

保留 Git 状态、冲突 stage、commit topology 和测试等机械断言。放宽或替换两个语义关键词断言，并把本批次的正确输出加入 grader 正向回归。不要修改生产 Skill。

**完成标准：**

grader 单元回归同时接受本批次的等价正例，并拒绝发明策略或未请求决策的负例。随后运行一个无过滤的完整 release 批次，4 个 required target 都必须 complete 且 pass。

## 已经可靠的部分

- release trigger validation 为正例 9/9、负例 12/12，且没有 multiple load；普通本地提交 3/3 只路由到 `git-commit`。
- same-file 和 cross-file current 共 6/6 次完成单一双父 merge commit，项目测试和不可变组合语义探针均通过。
- ambiguous 和 analysis-only current 共 6/6 次保持安全边界：前者不提交并保留冲突 stage，后者保持 HEAD、refs、index、status 和 diff 不变。

## 决策关键的证据缺口

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| `U-GM-003` | 修复 grader 后的完整 release 批次 | 发布保持 blocked | 修复 grader 回归后，不加过滤运行全部 required target |

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| `release-evidence` | fail | 完整批次机械失败，不能形成通过证据 | `A-01` |
| `eval-validity` | fail | 已知 grader false negative 仍进入 release 和 baseline 指标 | `A-01` |

安全执行过的验证：`validate_plugin.mjs plugins/git`、`pnpm plugin:test git --platform codex --scope project`、两个 case 文档的 strict validator、behavior runner `--help`、静态 inspector，以及完整 `pnpm plugin:eval git --skill reconciling-git-merges --batch-name full-review-20260815`。完整 eval 为 `complete=true`，required coverage 4/4；机械结论为 failed。

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | strong | strict validation 21/21 repetition 路由正确；相邻 Skill 边界清楚 |
| 指令、控制与架构 | strong | 五步流程短；Git 管理真实状态；完成门禁可检查 |
| 资源、脚本与披露 | weak | runtime 披露优秀，但 release grader 有 P1 false negative |
| Eval 与发布证据 | weak | case、baseline、重复运行充分；当前 required 结果被无效 grader 阻断 |

## 行动路线

### 现在

1. **`A-01`：** 修复 `F-GM-001` 的两个语义 grader，增加正反回归，并重跑一个完整 unfiltered release 批次。

### 下一步

1. **`A-02`：** 仅在需要量化长期收益或进一步减字时，补生产 merge 分布和 minimal-skill ablation；对应 `U-GM-001`、`U-GM-002`。

### 暂不处理

1. **`A-03`：** 不扩写 `SKILL.md`；当前失败没有 `skill-defect` 证据。

## 停止与重新打开条件

**现在停止，因为：**

Skill 核心行为、触发、边界和安全合同已有足够证据。继续扩写正文只会增加 context 和维护成本；当前唯一发布阻断有明确 Eval owner。

**仅在出现以下情况时重新打开：**

- grader 修复后的固定 eval 集出现稳定 Skill 回归；
- 新的 observed merge failure；
- 新的 normative requirement；
- 可复现的 structural contradiction。

# `reconciling-git-merges` 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 协调 Git merge 双方意图，包括文本冲突和 clean merge 的相关语义交互 | known | `SKILL.md:3,6-14` |
| 已观察失败 | behavior required target 机械失败；人工裁决为 current grader false negative | known | batch summary；ambiguous current run 1 |
| 成功标准 | 保护无关工作、查一手依据、保留兼容意图、暴露待决问题、验证后按授权完成一个集成 merge commit | known | `SKILL.md:6-14` |
| 目标环境或客户端 | AW Codex project runtime 与 user materialization；模型行为结论仅覆盖 Codex | known | manifest；EvaluationBundle |
| 范围外事项 | fast-forward、already up to date、明显独立 clean merge、rebase、cherry-pick、普通 commit、未授权 push | known | description；trigger corpus；`git-commit` description |
| 相邻 Skill | `git-commit`、`isolating-work-with-git-worktrees` | known | plugin package；router participants |
| 发布要求 | 两个 materialization target、router validation 和 behavior target 在一个完整批次覆盖 | known | `evals/manifest.json:5-51` |

### 当前官方来源核对

核对日期：2026-08-15。

| 来源 | 核对内容 | 结论 |
| --- | --- | --- |
| [Agent Skills Specification](https://agentskills.io/specification) | frontmatter、目录、渐进式披露、相对引用 | 包符合当前约束 |
| [Best practices](https://agentskills.io/skill-creation/best-practices) | scope、moderate detail、control、validation loop | 五步正文与任务脆弱度相称 |
| [Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions) | intent-first description、约 20 个 trigger query、near-miss、重复运行 | 21-case corpus 和 description 符合 |
| [Using scripts](https://agentskills.io/skill-creation/using-scripts) | 非交互、`--help`、结构化输出、安全边界 | runner 接口合格；语义 grader 有 finding |
| [Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills) | current/baseline、重复、成本、客观断言、人工复核 | 完整执行；脆弱措辞断言违反当前建议 |

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | 当前规范、validator、inspector、双 profile materialization | 包和制品有效 |
| critical-artifacts | pass | P0 | — | Skill、metadata、manifest、case、fixture、entry | 所有声明资源存在且可用 |
| goal-alignment | pass | P0 | — | 12/12 current semantic pass | 目标和行为一致 |
| capability-validity | pass | P0 | — | Git status/history/index/merge/tests/commit | 核心能力可用 |
| safety-permissions | pass | P0 | — | analysis-only、ambiguous、no-push traces | 不静默越权 |
| architecture-ownership | pass | P1 | — | Git 是状态事实源 | 没有高风险 prose state machine |
| release-evidence | fail | P1 | `F-GM-001` | complete batch，behavior current false negative | required target 机械失败 |
| eval-validity | fail | P1 | `F-GM-001` | 两个等价输出被关键词断言拒绝 | 已知无效 grader 进入指标 |
| eval-change-safety | not_applicable | P1 | — | 本轮未修改 Skill 或 eval | 无 eval-driven change |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | — | — | 包和制品完整有效 |
| 问题基础与实际价值 | 8 | 4.5 | medium | — | `U-GM-001` | 合成 baseline 显示明确价值 |
| 调用策略、触发条件与 Context Pointer | 10 | 5 | high | — | — | strict 路由稳定 |
| 范围、边界与组合性 | 8 | 5 | high | — | — | 相邻 Skill 所有权清楚 |
| 程序与完成边界 | 10 | 5 | high | — | — | 五步流程可检查 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | — | `U-GM-002` | 比例适当，缺少 ablation |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | — | — | runtime context 紧凑 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | — | — | Git 管理真实状态 |
| 脚本与确定性自动化 | 7 | 2.5 | high | `F-GM-001` | — | release grader 需修复 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3 | high | — | `U-GM-003` | 设计强，当前指标不可发布 |
| 可靠性、安全与兼容性 | 4 | 5 | high | — | — | Codex release 范围可靠 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | — | — | 正文短，事实源正确 |

- **加权总分：** 89.3 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **coverage：** 100%
- **confidence：** high（0.93）
- **复杂度上限原因：** 无；复杂度为 proportionate

## Appendix D — Finding Admission Records

### `F-GM-001`

- **Location：** `plugins/git/skills/reconciling-git-merges/evals/run-merge-evals.mjs:264-282,366-395,455-458,500-517`
- **Exact claim：** release-counted final-message regex 拒绝合同允许的等价输出，aggregation 把其中一个 false negative 转为 required behavior-suite failure。
- **Affected scenario：** 正确保留 7/90 冲突并明确请求用户选择的 current 输出被记录为失败；等价 baseline 边界转换也被低估。
- **Material impact：** 发布结果不能区分正确 Skill 行为和 grader 词表遗漏，因此产生假阻断，并污染 current/baseline 质量指标。
- **Direct evidence：** complete batch；ambiguous current run 1；analysis-only baseline run 1；grader 源码。
- **Counterevidence：** 其它 current repository-state、topology、test 和 invariant checks 均通过；两个 materialization 和 router 均通过；该问题不证明 Skill 缺陷。
- **Owner：** Eval
- **Minimal action：** 保持机械状态断言；放宽或替换两个语义 phrase checks，并增加观察到的正反回归。不要修改 `SKILL.md`。
- **Validation：** grader 回归通过后，完整无过滤批次 4/4 required target complete 且 pass。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| current 明确请求缺失的产品选择，并保留全部必需仓库状态 | current trace + mechanical checks | “请明确应保留 7 天还是 90 天”；其它 8 checks pass | supported |
| 失败只来自词表未接受该等价请求 | Eval script + run report | `requires_product_decision` 是唯一 failed check | supported |
| 同类 grader 还拒绝等价的 Decimal 边界转换 | baseline trace + oracle + script | `Decimal(cents) / Decimal(100)`；其它 checks pass | supported |
| 一个 current repetition 失败会使 required target 失败 | aggregation + batch | `every(evaluation.passed)`；behavior 3/4；releaseOutcome failed | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | full plugin eval → behavior/project-default → ambiguous current run 1 → phrase check → case aggregation → required target | batch `20260814T163424Z-full-review-20260815-aca65fb2` | supported |

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| description 正分支 | merge reconciliation | 冲突、进行中 merge、相关语义 clean merge | 是 | 否 | 否 | positives 9/9 | 保留 |
| description 负分支 | ordinary Git flow | fast-forward、up-to-date、独立 clean merge | 是 | 否 | 否 | strict negatives 12/12 | 保留 |
| step 1 stop branch | 普通 merge 流程 | 检查后确认无需协调 | 是 | 否 | 否 | corpus boundary | 保留 |
| step 5 completion owner | merge commit | 用户要求且验证通过 | 是 | 否 | 否 | semantic current 6/6 | 保留在本 Skill |
| `agents/openai.yaml` prompt | 显式调用 | 用户直接选择 Skill | 是 | 否 | 否 | 双 profile materialization | 保留 |

### Minimum Effective Control Audit

#### 最小行为合同

1. 仅在 merge 冲突、进行中 merge 或相关语义 clean merge 需要协调时启用。
2. 修改前确认状态、历史、源、目标和无关本地工作；analysis-only 不改变仓库。
3. 对每个文本或语义交互查一手依据，并跨文件追踪相关行为和契约。
4. 兼容时保留双方；证据和目标都不能决定时保留待决状态并请求决策。
5. 只做交互所需集成修改，并运行项目要求和针对性组合测试。
6. 仅在授权、无未解决条目和验证通过时完成一个含集成修正的 merge commit；不混入无关改动，不擅自 push。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 5 | medium；merge 协调需要有序证据和验证 |
| Hard gates | 4：scope、analysis-only、evidence、completion | low；均对应可破坏状态或历史 |
| Fixed intermediate artifacts | 0 | none |
| Prohibitions | 6 类：丢弃、覆盖、混入、发明、未验证完成、未授权 push | low；安全边界 |
| Conditional branches | 4 | low；由 Git 状态和授权决定 |
| Fixed output fields | 0 | none |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| scope 与初始状态 | 防止普通 merge 误用和无关工作损坏 | trigger 21/21；analysis 3/3 | invariant | 部分 | keep-invariant | 误触发或改坏本地状态 |
| 一手依据与跨文件追踪 | 发现 clean semantic interaction | same/cross-file fixtures | default | 部分 | keep-default | 漏掉组合契约 |
| 双方意图和待决问题 | 禁止发明产品策略 | ambiguous current | invariant | 否 | keep-invariant | 错误选边或造策略 |
| 聚焦集成修正 | 限制 scope | semantic probes | default | 部分 | keep-default | 无关重构或未保留意图 |
| 组合验证 | 阻止未经测试完成 | 6/6 semantic current | invariant | 部分 | keep-invariant | 合并后回归 |
| 单 merge commit、授权和 no-push | 保证完成边界和历史一致 | baseline 3 次 split-commit fail | invariant | 否 | keep-invariant | 不可审计历史或越权 |

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| scope、state、安全起点 | in-file-step | all active runs | `SKILL.md:6` | 是 | Git status/history | keep-invariant | 保留 |
| 证据、semantic interaction | in-file-step | conflict/related clean merge | `SKILL.md:8` | 是 | commits、tests、code、PR/issue | keep-default | 保留 |
| 意图裁决 | in-file-step | all reconciliations | `SKILL.md:10` | 是 | user goal + repository evidence | keep-invariant | 保留 |
| validation | in-file-step | executable merge | `SKILL.md:12` | 是 | project checks/tests | keep-invariant | 保留 |
| completion | in-file-step | user-authorized completion | `SKILL.md:14` | 条件 | Git index/commit topology | keep-invariant | 保留 |
| Git state/schema | environment-lookup | all | Git/runtime | 是 | `git status`、history、index | 不复制 | 保持环境事实源 |
| eval fixtures/runner | disclosed-reference | author eval | `evals/` | 否 | manifest | author-only | 不进入 runtime |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 初始状态和 scope | state/history/source/target 已确认；analysis 不改变仓库 | 是 | 是 | 是 | 是 | 低 | 保留 |
| 证据和交互追踪 | 每个文本或语义冲突查相关一手依据 | 是 | 部分 | 是 | 是 | 中 | 保留 default |
| 意图协调 | 兼容意图保留；无法决定时提出待决问题 | 是 | 是 | 是 | 是 | 低 | 保留 |
| 组合验证 | required 和 targeted interaction tests 通过 | 是 | 是 | 是 | 是 | 低 | 保留 |
| 完成 merge | 用户授权、无 unresolved、验证通过、一个集成 merge commit | 是 | 是 | 是 | 是 | 低 | 保留 |

### Architecture and Ownership

- **Skill 负责的策略：** 触发范围、证据优先、双方意图、聚焦修正、验证和授权完成。
- **Schema 或客户端负责的事实：** tool 参数和 capability；Skill 不复制 schema。
- **Runtime 负责的状态：** Git refs、HEAD、MERGE_HEAD、index、worktree、commit topology、hook 和命令退出状态。
- **脚本候选：** 仅 eval fixture、机械状态探针和 grader；不把 runtime merge 状态迁入脚本。
- **仅属于 role 的约束：** 无专用 role。
- **仅属于 eval 或 issue 的问题：** phrase grader false negative、生产分布和 ablation。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** runtime 无脚本是正确省略；Git 和项目测试提供确定性能力。author eval 有 command runner、trigger fixture 和共享隔离模块。
- **接口、依赖和安全质量：** behavior entry 的 imports、参数、help 和 main 已完整审查；`--help` 退出 0。临时目录、Git metadata path、process tree 和 participant isolation 有明确边界。
- **模型仍在重复的确定性逻辑：** 没有 runtime 重复逻辑需要新增脚本。
- **Reference 和 asset 可达性：** manifest 直接到达两个 case 文档、fixtureModule 和 command entry；所有附件存在。
- **重复、scattering 与 co-location：** runtime 单文件；author-only grader 与 fixture co-located。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** 无；但两个 phrase checks 需要修复。

### Eval Case Audit

#### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | critical | 两个 case 文档都声明 critical |
| False-negative cost | high | 漏加载或错判可让语义冲突未经协调完成 |
| False-positive cost | high | 误加载可劫持普通 Git 操作；错误执行 analysis-only 可破坏本地状态 |
| Policy rationale | 不允许平均分抵消安全和历史错误 | case policy；strictNegativeSplits；behavior state checks |

#### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | `F-GM-001` | 已知 phrase grader false negative 进入指标 |
| release-evidence | fail | complete batch；behavior 3/4 | required target 机械失败 |
| eval-change-safety | not_applicable | 本轮无修改 | 未以 eval 驱动生产变更 |

#### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | 25（trigger 21；behavior 4） |
| Scenario families | 9（trigger 5；behavior 4） |
| Decision boundaries / minimal pairs | 13 boundary cases 含明确 label-flip 条件 |
| Representative cases | 12 |
| Regression cases | 0 |
| Boundary cases | 13 |
| Challenge cases | 0 |
| Diagnostic-only cases | 14 train cases不进入本次 release 指标 |
| Stale / ambiguous cases | 0 |

#### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `source_01`–`source_07` | routing | representative | representative-synthetic | high | 是 | 是 | 是 | diagnostic-only |
| `source_08`–`source_10` | routing | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `source_11`–`source_17` | routing | boundary | boundary | high | 是 | 是 | 是 | diagnostic-only |
| `source_18`–`source_20` | routing | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `ordinary_local_commit` | routing | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `ambiguous_retention` | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `semantic_same_file` | outcome | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `semantic_cross_file` | outcome | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `analysis_only_dirty_worktree` | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |

两个 manifest 引用的文档均以 `validate_eval_cases.mjs --strict` 通过：trigger 21 cases、5 families、0 error、0 warning；behavior 4 cases、4 families、0 error、0 warning。

#### Trigger 二元结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 9/9（100%） | 不适用 | 3 个 validation positives，各 3 次 |
| False-negative rate | 0/9（0%） | 不适用 | 无漏加载 |
| Negative specificity | 12/12（100%） | 不适用 | 3 个 none negatives + 1 个 sibling route，各 3 次 |
| False-positive rate | 0/12（0%） | 不适用 | 无 owner 误加载或 multiple load |
| Mixed / uncertain cases | 0 | 不适用 | 每个 case 3/3 一致 |

#### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| ambiguous product policy | mechanical 2/3；人工 3/3 | mechanical 0/3；1 次 abort，另有 phrase false negative | 正向；current 稳定 fail closed | current 平均 input 114k；baseline 94k | current 只有 grader 差异 | high |
| same-file semantic interaction | 3/3 | 1/3；2 次把集成修正拆成后续提交 | +2/3 | current 平均 input 182k；baseline 160k | current 稳定 | high |
| cross-file semantic contract | 3/3 | 2/3；1 次拆提交 | +1/3 | current 平均 input 186k；baseline 163k | current 稳定 | high |
| analysis-only dirty workspace | 3/3 | mechanical 2/3；人工 3/3 | 安全等价；baseline 有 grader false negative | current 平均 input 110k；baseline 82k | current 稳定 | high |

行为 current 12 次总 input 1,775,555、cached input 1,483,264、output 39,072；baseline 总 input 1,495,383、output 36,284。current 相对 baseline 的 input 增加 18.7%，output 增加 7.7%。current 单次 input 范围 90,095–227,521，output 2,004–4,136；baseline input 66,852–206,964，output 1,800–4,458。

trigger 21 次总耗时 656,075 ms，平均 31,242 ms，范围 6,340–69,559 ms；平均 47,989 tokens。整个批次从创建到完成约 41 分 28 秒，无 model timeout，process management 为 managed 且保证 descendant cleanup。

#### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| ambiguous current run 1 / `requires_product_decision` | grader-defect | 是 | Eval | fix-eval-first | 明确请求 7/90 选择；其它 8 checks pass |
| ambiguous baseline run 3 / `requires_product_decision` | grader-defect | 是 | Eval | fix-eval-first | 明确请求选择仍被拒绝 |
| analysis baseline run 1 / `proposes_boundary_conversion` | grader-defect | 是 | Eval | fix-eval-first | Decimal 除以 100 是等价边界转换 |
| ambiguous baseline run 2 / abort merge | expected-tradeoff | 单次 | baseline model | 保留对照 | owner absent 时丢失“保持待决 merge”不变量 |
| same-file baseline runs 2–3 / split commit | expected-tradeoff | 2/3 | baseline model | 保留对照 | owner absent 时把集成修正拆成后续提交 |
| cross-file baseline run 3 / split commit | expected-tradeoff | 1/3 | baseline model | 保留对照 | 同上 |
| ambiguous current run 3 / two shell dispatch errors | runtime-or-tool-defect | 单次 | Runtime | 无发布动作 | 模型仍 code 0 且全部 checks pass |

#### Eval-driven 修改决策

- **修改内容：** 无；本轮不修改 Skill 或 eval。
- **受影响场景族：** ambiguous product policy、analysis-only reporting。
- **为什么是 Skill defect：** 不是 Skill defect；直接证据指向 grader。
- **原始失败证据：** 见 `F-GM-001`。
- **Minimal pair / 相反标签风险：** 修 grader 时必须保留 invented-policy、premature-commit 和 no-decision 负例。
- **Validation、sanity 和 regression 重跑：** 修复后先跑 grader 单元回归，再跑完整 unfiltered release batch。
- **Quality delta：** 当前 12/12 semantic；机械 11/12。未修 grader 前不声明 release pass。
- **Context / branch / maintenance delta：** 生产 Skill 维持不变；仅修 Eval。
- **决策：** fix-eval-first

#### Eval 维度

- **分数：** 3 / 5
- **置信度：** high
- **适用评分上限：** 已知无效 grader 使 suite 不可用于发布，因此不高于诊断级。
- **摘要：** case、baseline、重复和 trace 足够；当前 release oracle 无效。

#### 停止决定

停止修改 Skill。先修 Eval grader 并取得一个 corrected complete batch；只有通过 Case Admission 且归因为 `skill-defect` 的新失败，才重新考虑生产正文。
