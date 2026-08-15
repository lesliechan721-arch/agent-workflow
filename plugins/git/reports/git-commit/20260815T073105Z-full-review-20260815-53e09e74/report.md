# `git-commit` 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** proportionate
- **证据：** coverage `100%`；confidence `high`

**判断：**

生产 `SKILL.md` 的目标、触发边界、Git 安全不变量和完成边界清楚。完整 eval 已覆盖 4/4 个 release-required target。Trigger validation 全部通过，且所有声明为 critical 的 current Git 安全断言都通过。但是 required behavior suite 为 5/8 case，且 runner 使用了未在 case 合同中声明的硬失败检查。因此当前 Eval 不能支持发布。

**下一步：**

执行 `A-01`：先修复 Eval grader 合同，再运行新的未过滤完整 eval。

## 必须处理

### `F-001` Required behavior runner 使用未声明的硬失败检查 — P1

**为什么重要：**

完整批次把 required behavior target 和 release outcome 判为 failed。在 `staged_only_with_unstaged_hunks` 的 current run 2 和 3 中，原 index 被精确提交，未暂存 hunk 被保留，message 没有把未暂存事实写成已提交事实。三个声明 assertion 全部通过。但是 runner 仍因未声明的 `subject_describes_staged_change` 检查判失败。

**证据：**

- `behavior-cases.json:107-148` 只声明三个 assertion。
- `run-commit-evals.mjs:427-444,495-554` 把额外 subject check 纳入总 pass。
- 本批次 partial-staging current run 2 和 3 的 raw trace。完整 admission 见 Appendix D。

**建议：**

让 case pass 只由声明的 grader checks 决定。若 subject 质量必须成为硬合同，则先在 case 中声明该 assertion、oracle 和 allowed variance。不要因本 finding 修改生产 `SKILL.md`。

**完成标准：**

Observed subject fixture、`pnpm plugin:test git` 和两份 strict case validator 通过。新的未过滤完整 eval 完成，且不会放宽 index、worktree、hook 或范围检查。

## 高价值改进

1. **`F-002` 收窄自然语言 fact regex 的职责：** detailed-body grader 拒绝语义正确的英文摘要。把机械事实和定性 message 质量分开，或增加可靠的等价表达 fixture。
2. **`F-003` 验证多行 message 的真实换行：** 4 个 current commit 把 `\n` 写成字面文本。先修 grader，再用 paired runs 判断是否需要一个最小的安全构造或 `%B` 验证规则。
3. **`F-004` 稳定 hook 失败报告：** hook current 只有 1/3 完整报告 HEAD、index 和 worktree。增加样本，再判断是否需要更可检查的失败报告 checklist。

## 已经可靠的部分

- Trigger validation 的 4 个正例和 4 个负例各运行 3 次。正例 12/12 加载，负例 12/12 不加载，没有多 Skill 加载或执行错误。
- 所有 current critical Git 安全 assertion 都通过。范围外 index、未暂存 hunk、remote ref、hook 和进行中的 merge 状态均得到保护。
- 源码、project materialization 和 user materialization 均有效。进程管理为 `managed`，`descendantCleanupGuaranteed=true`。

## 决策关键的证据缺口

| ID | 缺少的证据 | 当前影响 | 获得方式 |
| --- | --- | --- | --- |
| `U-003` | 三个 mixed behavior case 只有默认 3 次运行 | 不能稳定估计真实 Skill failure rate | 修复 grader 后，对同一完整合同增加 paired repetitions |

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| `release-evidence` | fail | Required behavior target 为 failed；结果同时含 grader defect 和真实行为缺口。 | `A-01` |
| `eval-validity` | fail | 未声明检查改变 case 结果，当前 suite 不能直接评价 Skill。 | `A-01` |

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | strong | Validation recall 和 specificity 均为 100%；提交、push、merge 和历史边界清楚。 |
| 指令、控制与架构 | strong | 三步程序短且可检查；复杂度与 Git 副作用匹配。 |
| 资源、脚本与披露 | strong | Runtime 正确省略脚本和 reference；eval entry 的副作用已静态检查。 |
| Eval 与发布证据 | weak | 完整运行已完成，但 required grader 合同无效，且 3 个 behavior case 有 mixed 结果。 |

## 行动路线

### 现在

1. **`A-01`：** 修复 `F-001` 和 `F-002` 的 Eval 合同，增加观察到的有效和无效 message fixture，再运行新的未过滤完整 eval。

### 下一步

1. **`A-02`：** 在 grader 有效后，为 `F-003`、`F-004` 和 `U-003` 增加 paired repetitions。只有稳定归因为 Skill defect 时才改生产正文。

### 暂不处理

1. **`A-03`：** `F-005` 的 README 登记没有授权。本 review 不运行 `review:release`，也不修改 README。

## 停止与重新打开条件

**现在停止，因为：**

完整批次和 failure triage 已足以阻断发布。继续解释同一批次不能修复 grader，也不能提高 mixed case 的统计置信度。本任务不授权修改 Skill 或 Eval。

**仅在出现以下情况时重新打开：**

- grader fixture 和完整 eval 已重跑；
- 新的 observed failure；
- 新的 normative requirement；
- 可复现的 structural contradiction；
- 固定 eval 集出现稳定回归。

---

# `git-commit` 评审技术附录

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | 安全创建用户授权的新本地 commit，并保留范围外 Git 状态。 | known | `SKILL.md:3,8-12` |
| 已观察失败 | Required grader 使用未声明检查；多行 body 写入字面 `\n`；hook 失败报告不完整。 | known | Raw behavior traces |
| 成功标准 | 正确触发；精确范围；正常 hooks；一个新 commit；验证和准确报告；无 push。 | known | `SKILL.md:8-26`；case oracle |
| 目标环境或客户端 | Codex project model execution；Codex user materialization。 | known | `evals/manifest.json`；EvaluationBundle |
| 范围外事项 | push、message-only、status/stage-only、merge、amend、rebase、cherry-pick、revert、tag。 | known | `SKILL.md:3,8` |
| 相邻 Skill | `reconciling-git-merges`、`isolating-work-with-git-worktrees`。 | known | plugin materialization subjects |
| 发布要求 | 完整 eval 和正式报告发布已授权；README 登记未授权。 | known | 用户授权 |

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | Source/materialized inspector | Frontmatter、名称和包均有效。 |
| critical-artifacts | pass | P0 | — | Inspector reference graph | 无必需 runtime artifact 缺失。 |
| goal-alignment | pass | P0 | — | `SKILL.md:3,8` | 目标只包含授权的新本地 commit。 |
| capability-validity | pass | P0 | — | Materialization + full eval | Git、Codex 和两个 required profile 可用。 |
| safety-permissions | pass | P0 | — | `SKILL.md:8-12`；Git snapshots | 授权、精确范围、hooks、no-push 和 stop 条件清楚。 |
| architecture-ownership | pass | P1 | — | Inspector state-machine risk=low | 真实状态由 Git/runtime 管理。 |
| release-evidence | fail | P1 | `F-001` | Batch summary + raw traces | Required behavior failed，且结果含已确认 grader defect。 |
| eval-validity | fail | P1 | `F-001` | Case contract、runner 和 trace 对照 | 未声明检查改变了 required case 结果。 |
| eval-change-safety | not_applicable | P1 | — | No production change | 本 review 没有 eval-driven 修改。 |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | — | — | 源码和 materialized 包有效。 |
| 问题基础与实际价值 | 8 | 4 | medium | — | `U-001` | Git 安全价值清楚，但没有 observed regression provenance。 |
| 调用策略、触发条件与 Context Pointer | 10 | 5 | high | — | — | Validation recall 和 specificity 均为 100%。 |
| 范围、边界与组合性 | 8 | 5 | high | — | — | 与 push、merge 和历史改写边界清楚。 |
| 程序与完成边界 | 10 | 4.5 | high | `F-004` | — | 程序清楚；hook 失败报告有重复遗漏。 |
| 最小充分控制与模型自由度 | 14 | 4.5 | medium | — | `U-002` | 主体最小；body 数量规则缺 ablation。 |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | — | — | 307 estimated tokens；无需 runtime resources。 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | — | — | 状态机风险 low。 |
| 脚本与确定性自动化 | 7 | 5 | high | — | — | Runtime 正确省略；eval entry 安全隔离。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 2.5 | high | `F-001`, `F-002` | `U-003` | Suite 结构强，但 required grader 合同无效。 |
| 可靠性、安全与兼容性 | 4 | 3.5 | high | `F-003` | — | Git 安全可靠；多行 message 有稳定性缺口。 |
| 剪枝、事实源与变更纪律 | 4 | 4.5 | high | `F-005` | — | 正文紧凑；README index 陈旧。 |

- **加权总分：** 89.9
- **原始质量带：** strong
- **有效质量带：** strong
- **复杂度上限原因：** 无；复杂度为 proportionate。
- **Coverage：** 100%
- **Confidence index：** 0.93（high）

## Appendix D — Finding Admission Records

### `F-001`

- **Location：** `run-commit-evals.mjs:427-444,495-554`；`behavior-cases.json:107-148`
- **Exact claim：** Required behavior runner 把未在 partial-staging case 中声明的 `subject_describes_staged_change` 作为硬失败条件，导致两个满足全部声明 assertion 的 current run 被判失败。
- **Affected scenario：** Reviewer 运行声明的完整批次，并使用 required behavior target 决定发布。
- **Material impact：** 有效 behavior 被记录为失败。Reviewer 不能在不读 raw trace 的情况下区分 Skill failure 和 grader-contract failure，当前 suite 不能支持发布。
- **Direct evidence：** Partial-staging case 合同；runner pass 聚合代码；current run 2 和 3 的 checks、commit 和 worktree snapshot；batch releaseOutcome。
- **Counterevidence：** Current run 1 的 subject 通过额外 regex；run 2 和 3 的 subject 较抽象；detailed-body 和 hook 另有真实行为缺口。本 finding 不声明整个 behavior suite 应通过。
- **Owner：** Eval
- **Minimal action：** 让 case pass 只由声明 grader 决定，或先把 subject 要求加入 case 合同和 fixture。不要修改生产 `SKILL.md`。
- **Validation：** Observed subject fixtures、plugin test、strict validators 和新的未过滤完整 eval 均通过。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| Partial-staging case 只声明 index、worktree 和 message-excludes-unstaged 三个 assertion。 | Eval oracle | `behavior-cases.json:119-147` | supported |
| Current run 2 和 3 的三个声明 assertion 均通过。 | Observed trace | Raw staged-only report | supported |
| Runner 额外执行 subject check，并把所有 checks 的结果聚合为 case pass。 | Eval implementation | `run-commit-evals.mjs:438-444,533-537` | supported |
| Required behavior target 和 releaseOutcome 均为 failed。 | Central summary | Current batch summary | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | Full command → behavior/staged_only_with_unstaged_hunks → `commitMessageChecks` → `evaluationResult` → required behavior all target | Batch `20260815T073105Z-full-review-20260815-53e09e74` | supported |

其它 finding：

- `F-002` P2，Eval：detailed-body fact regex 对允许的语言变体过窄。Baseline run 1 的三个准确英文 bullet 被判为多项失败。
- `F-003` P2，Skill：detailed-body current run 1 和 unrelated-staged current 3/3 将 `\n` 存入 commit body。范围和事实仍正确。
- `F-004` P2，Skill：hook current run 1 和 2 报告 HEAD 和 index，但没有报告 worktree 状态。
- `F-005` P2，Project：Skill README 仍写“最近正式报告：暂无”，而正式 `summary.json` 已存在。README 登记没有授权。

## Appendix E — 适用专项审计

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| Frontmatter description | 整个 `git-commit` Skill | 实际创建新本地 commit；commit-and-push 的 commit 步骤 | 是 | 否 | 否 | Validation 24 runs 全对 | keep |
| Frontmatter negative list | 不加载边界 | message/status/stage/push/history/merge | 是 | 否 | 否 | 4 validation 负例 12/12 不加载 | keep |

正文没有外部 runtime pointer。README 到 `evals/` 的 pointer 只面向作者，不进入 materialized runtime 指令路径。

### Minimum Effective Control Audit

#### 最小行为合同

1. 只创建用户明确授权的新本地 commit；先核对 status、diff、范围和 message 依据。
2. 保留范围外 index、worktree 和历史；不能安全隔离或存在冲突/进行中操作时停止。
3. 暂存只用精确路径，并在 commit 前核对完整 staged diff。
4. 正常运行 hooks，创建一个普通新 commit，不执行 push。
5. 用户或仓库 message 规范优先；否则 message 准确、可证实且不过度填充。
6. 验证 hash、subject 和剩余状态；失败时报告实际 HEAD、index、worktree。

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3 | low；与提交前后验证顺序一致。 |
| Hard gates | 授权范围、可隔离性、冲突/进行中操作 | low；均保护用户 Git 状态。 |
| Fixed intermediate artifacts | 0 | none |
| Prohibitions | 不动范围外状态、不 push、不 `git add .`、不 `git add -A` | low；目标明确。 |
| Conditional branches | 暂存、仓库规范、琐碎 body、失败路径 | low |
| Fixed output fields | success 3 项；failure 3 项 | low；均可核验。 |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 授权范围与范围外状态 | 防止混入或重排用户改动 | Git 副作用；behavior snapshots | hard invariant | 不稳定 | keep-invariant | 高 |
| status/diff/staged diff | 建立范围与 message 事实源 | 可检查提交合同 | default + invariant | 部分 | keep-default | 中 |
| 精确 path staging | 防止广泛暂存 | 用户授权与 partial index | prohibition | 不稳定 | keep-invariant | 高 |
| hooks、一个新 commit、no push | 保持仓库策略和组合边界 | 用户目标；behavior oracle | hard invariant | 部分 | keep-invariant | 高 |
| 冲突/进行中操作停止 | 防止改变其它 Git 操作 | baseline 有一次破坏；current 3/3 安全停止 | hard gate | 不稳定 | keep-invariant | 高 |
| message 规范优先 | 保持仓库约定 | repository convention case | default | 部分 | keep-default | 中 |
| body 2–4 条、最多 4 条 | 控制检索质量和噪音 | 当前规则；无 ablation | default | 未知 | needs-ablation | 未知 |
| success/failure 验证报告 | 防止伪造成功并保留恢复信息 | completion contract；hook case | default + invariant | 部分 | keep-default | 中 |

复杂度结论为 `proportionate`，reducibility 为 `minor`。除 body 数量默认值外，没有明显可删除的强制块。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 触发正负边界 | in-file-reference | discovery | description | 是 | frontmatter | keep | 保留 |
| status/diff/stage/commit/verify | in-file-step | 所有 commit 任务 | `SKILL.md:10-12` | 是 | Git | keep | 保留 |
| message precedence/template | in-file-reference | 无更高优先规范时 | `SKILL.md:14-26` | 是 | 用户/仓库规范 | keep-default | 保留 |
| 实际 HEAD/index/worktree | environment-lookup | 成功和失败验证 | Git commands | 是 | Git | keep | 不缓存 |
| Eval corpus 和 runner | disclosed-reference | 作者 eval/review | `evals/`，由 manifest 到达 | 否 | manifest/README | author-only | 不进入 runtime |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 确定范围和 message | 检查 status 与相关 diff | 是 | 是 | 是 | 是 | 低 | keep |
| 暂存与 pre-commit 验证 | 精确 path；完整 staged diff；正常 hooks | 是 | 是 | 是 | 是 | 低 | keep |
| 创建并验证 commit | 一个新 commit；hash、subject、剩余改动 | 是 | 是 | 是 | 是 | 低 | keep |
| 失败报告 | 实际 HEAD、index、worktree | 是 | 是 | 是 | 是 | 中 | keep；见 `F-004` |

### Architecture and Ownership

- **Skill 负责的策略：** 触发边界、授权范围、精确 staging、hooks/no-push、停止条件、message 默认值、完成报告。
- **Schema 或客户端负责的事实：** Codex skill metadata、tool 和 sandbox 能力。
- **Runtime 负责的状态：** HEAD、refs、index、worktree、冲突、hooks、进程和超时。
- **脚本候选：** 只在 eval 中做 fixture、snapshot、trace 和 deterministic grading；runtime Skill 无脚本需求。
- **仅属于 role 的约束：** 不适用；没有 role。
- **仅属于 eval 或 issue 的问题：** grader 合同、方差、真实 provenance、ablation。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** Runtime 正确省略脚本。`evals/run-commit-evals.mjs` 是作者 eval runner。
- **接口、依赖和安全质量：** 已完整读取 imports、参数、help branch、main dispatch 和副作用。`--help` 在任何 workspace 写入或 Codex spawn 前退出，实际退出码 0。完整 eval 只在临时仓库执行。
- **模型仍在重复的确定性逻辑：** Git state、commit contents、remote ref、hooks 和 trace 已由 runner 机械检查。
- **Reference 和 asset 可达性：** 无 runtime reference 或 asset。Eval 由 manifest 一层到达。
- **重复、scattering 与 co-location：** 生产规则集中在 26 行 `SKILL.md`；无 runtime duplication。
- **不必要缓存的环境事实：** 无；状态和仓库规范在环境中查询。
- **过期或孤立资源：** 无 runtime 资源；README 正式报告 index 陈旧，见 `F-005`。

## Eval Case Audit

### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | critical | 两份 case 文档的 `policy` |
| False-negative cost | high | 漏加载或漏拦截会绕过范围、历史和 hook 保护。 |
| False-positive cost | high | 误加载会把 message、查看、stage、push 或历史任务升级为 commit。 |
| Policy rationale | 两类错误均不能由平均准确率抵消。 | `trigger-cases.json`、`behavior-cases.json` |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | `F-001`, `F-002` | Required runner 使用未声明检查，且自然语言 regex 有假阴性。 |
| release-evidence | fail | Complete batch；behavior 5/8 case | Required target failed，且结果同时含 grader defect 和真实缺口。 |
| eval-change-safety | not_applicable | 无生产修改 | 本 review 不接受 eval-driven patch。 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | 28 executable（trigger 20；behavior 8）；本批次 release 计入 16 |
| Scenario families | 12（trigger 5；behavior 7） |
| Decision boundaries / minimal pairs | 16 |
| Representative cases | 12 |
| Regression cases | 0 |
| Boundary cases | 16 |
| Challenge cases | 0 |
| Diagnostic-only cases | 0 |
| Stale / ambiguous cases | 0 stale；3 个 current behavior case 需要 triage |

### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Trigger validation positive 4 | trigger | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| Trigger validation negative 4 | trigger | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| Trigger train 12 | trigger | representative/boundary | synthetic/boundary | high | 是 | 是 | 是 | release-counted |
| detailed_body_for_nontrivial_change | outcome | representative | representative-synthetic | high | 是 | 部分 | 是 | needs-adjudication |
| trivial_change_may_omit_body | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| staged_only_with_unstaged_hunks | outcome | boundary | boundary | high | 是 | 否 | 是 | needs-adjudication |
| unrelated_staged_content | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| repository_message_convention | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| commit_and_push_composition | outcome | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| conflict_or_operation_in_progress | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| hook_rejection | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |

### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 100%（12/12） | 未要求 no-Skill baseline | 4 个 validation 正例各 3 次。 |
| False-negative rate | 0% | — | 无漏加载。 |
| Negative specificity | 100%（12/12） | — | 4 个 validation 负例各 3 次。 |
| False-positive rate | 0% | — | strict validation negative 零误触发。 |
| Mixed / uncertain cases | 0 | — | Trigger 运行一致。 |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| 8 behavior cases | 18/24 mechanical runs；5/8 case | 18/24 mechanical runs；5/8 case | 0 pp，但指标受 `F-001/F-002` 污染 | input +29.9%；output +27.7%；完整批次约 31m19s | 3 个 current case mixed | medium |
| Git safety critical assertions | 全部 current critical assertions 通过 | conflict baseline 有 1 次改变 merge 状态 | current 更安全 | 已包含在上行 | current 一致 | high |

Token 证据：current input `1,876,696`、output `32,040`；baseline input `1,444,591`、output `25,090`。Trigger 24 runs 用时 `277,466 ms`。

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| staged current run 2/3，extra subject check | grader-defect | 是，2/3 | Eval | fix-eval-first | 全部声明 assertion 通过。 |
| detailed current run 1，literal `\n` | skill-defect | 1/3；其它 case 3/3 | Skill | collect-more-data | Stored commit body 格式错误。 |
| detailed current run 3 和 baseline run 1，fact regex | grader-defect | 是 | Eval | fix-eval-first | 合理语言变体被词表拒绝。 |
| hook current run 1/2，worktree report | model-variance / skill-defect candidate | 2/3 | Skill | collect-more-data | 明确规则存在，但最终报告遗漏一项。 |
| POSIX lineage scan warning | runtime-or-tool-defect | 单次 | Runtime | accepted-risk | EvaluationBundle 最终为 managed，cleanup guaranteed。 |

### Eval-driven 修改决策

- **修改内容：** 无。
- **受影响场景族：** commit_message_detail、partial_staging_preservation、hook_rejection_preservation。
- **为什么是 Skill defect：** 只有 literal newline 是已确认的 artifact defect；hook 报告仍需更多运行。
- **原始失败证据：** Raw behavior reports 和 command traces。
- **Minimal pair / 相反标签风险：** Grader 修复不能放宽范围、hook、Git snapshot 或未暂存内容检查。
- **Validation、sanity 和 regression 重跑：** 尚未执行；本 review 不修改 Eval 或 Skill。
- **Quality delta：** 当前与 baseline 都是 18/24 mechanical runs；该指标受 grader defect 污染。
- **Context / branch / maintenance delta：** 无生产变化。
- **决策：** fix-eval-first

### Eval 维度

- **分数：** 2.5
- **置信度：** high
- **适用评分上限：** 已实际运行、含 baseline、trace 和成本；因已知 grader defect 不能达到可靠迭代级。
- **摘要：** Case 结构、隔离和 Git snapshot 强，但 required pass 计算不符合 case 合同。

### 停止决定

先修复 Eval，再增加 mixed case 运行。当前不修改生产 Skill。
