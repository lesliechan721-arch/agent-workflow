# `git-commit` 评审

## 结论

- **设计结论：** needs-fixes
- **发布就绪度：** blocked
- **复杂度：** proportionate
- **证据：** coverage `100%`；confidence `high`

**判断：**

生产 `SKILL.md` 的目标、触发边界、Git 安全不变量和完成边界清楚。Trigger validation 的正例 recall 和负例 specificity 都是 100%。完整 release eval 已完成，但 required behavior suite 失败。Trace 证明至少两个自然语言 grader 有假阴性，因此本批次不能支持发布。P1 的 owner 是 Eval，不是生产 Skill。

**下一步：**

执行 `A-01`：先修复 grader 并重跑完整 release eval。

## 必须处理

### `F-001` Required behavior grader 拒绝符合 oracle 的输出 — P1

**为什么重要：**

完整批次把 required behavior target 和 release outcome 判为 failed。Hook current run 1 和 run 3 已报告实际 HEAD hash、保留的 staged 文件和无未暂存改动，Git snapshot 也保持不变，但 grader 因固定措辞要求把它们判为失败。这会把有效行为写成发布失败。

**证据：**

- `run-commit-evals.mjs:450-486` 的 `reportsUnchangedHead` 要求“仍为/未变”等固定表达。
- `behavior-cases.json:354-365` 明确允许等价术语。
- 批次 `20260814T163422Z-full-review-20260815-85a155ac` 的 hook current run 1 和 3 均出现该假阴性。完整 admission 见 Appendix D。

**建议：**

用确定性 fixture 固定已观察到的有效输出。比较消息中的 exact HEAD hash，并接受 oracle 声明的等价 HEAD、index 和 worktree 表达。不要因本 finding 修改生产 `SKILL.md`。

**完成标准：**

Grader fixture、`plugin:test` 和两份 strict case validator 通过。新的未过滤 full release eval 完成，且修复不会放宽 Git snapshot、hook 或范围检查。

## 高价值改进

1. **`F-003` 验证多行 message 的真实换行：** 非琐碎 case 的 current run 1 和 2 把 `\n` 作为字面文本写进 commit body。先修 grader，再用 paired rerun 验证一个最小、安全的多行 message 默认值或完整 `%B` 验证。
2. **`F-002` 统一 fact 与 grouping 分类：** detailed-body run 3 的第一条 bullet 已把实现和测试合并，但 grouping regex 的 runtime 词表比 fact regex 窄。复用同一分类，并保留真正逐文件复述的负 fixture。

## 已经可靠的部分

- Trigger validation 的 4 个正例和 4 个负例各运行 3 次。正例 12/12 加载，负例 12/12 不加载，没有多 Skill 加载和执行错误。
- `unrelated_staged_content`、`commit_and_push_composition` 和 `conflict_or_operation_in_progress` 的 current 均为 3/3。范围外 index、远端 ref 和进行中的 merge 状态得到保护。
- 源码和 project/user materialized Skill 均通过静态诊断。运行时包只包含所需 Skill 文件，没有断裂引用或自然语言状态机。

## 发布限制

| Gate | 状态 | 对发布的影响 | Action ID |
| --- | --- | --- | --- |
| `release-evidence` | fail | Required behavior target failed，且结果含已确认 grader 假阴性。 | `A-01` |
| `eval-validity` | fail | 当前 behavior 结果不能直接评价 Skill。 | `A-01` |

安全执行的 release 验证：

- `inspect_skill_target.mjs`：源码 Skill 无 issue；带 EvaluationBundle 的插件检查仅报告 `evaluation.failed`。
- `validate_eval_cases.mjs --strict`：trigger 20 case、behavior 8 case 均为 0 error、0 warning。
- `run-commit-evals.mjs --help`：退出码 0。
- `pnpm plugin:eval git --skill git-commit --batch-name full-review-20260815`：批次 complete；trigger passed；behavior failed。
- 共享前置：`pnpm build`、`validate_plugin.mjs plugins/git`、`pnpm plugin:test git --platform codex --scope project` 已通过。

## 质量概览

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| 触发与范围 | strong | Validation recall/specificity 为 100%；push、merge 和历史边界明确。 |
| 指令、控制与架构 | strong | 三步程序短且可检查；复杂度与 Git 操作风险匹配。 |
| 资源、脚本与披露 | strong | 运行时正确省略脚本和 reference；eval entry 的接口与副作用已审查。 |
| Eval 与发布证据 | weak | Suite 结构强，但 grader 假阴性和真实 message 格式波动阻断发布。 |

## 行动路线

### 现在

1. **`A-01`：** 修复 `F-001` 和 `F-002` 的 grader 假阴性，增加确定性 fixture，重跑相同合同的完整 release eval。

### 下一步

1. **`A-02`：** 在 grader 有效后处理 `F-003`。用 paired runs 判断是否需要一个最小多行 message gotcha 或验证步骤。

### 暂不处理

1. **`A-03`：** `F-004` 的 README 登记未获授权，不在本 review 修改。`U-001` 的真实 provenance 和 `U-002` 的 ablation 可在下一轮证据建设中处理。

## 停止与重新打开条件

**现在停止，因为：**

归因已足以阻断发布。继续解释同一批次不会修复 grader，也不能证明生产 Skill 的净改进。当前没有授权修改生产 Skill 或 eval。

**仅在出现以下情况时重新打开：**

- grader fixture 和完整 release eval 已重跑；
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
| 已观察失败 | Required behavior eval 有 grader 假阴性；非琐碎 body 在 2/3 current run 中写入字面量 `\n`。 | known | Raw behavior traces |
| 成功标准 | 正确触发；精确范围；正常 hooks；一个新 commit；验证和准确报告；无 push。 | known | `SKILL.md:8-26`；case oracle |
| 目标环境或客户端 | Codex project model execution；Codex user materialization。 | known | `evals/manifest.json`；EvaluationBundle |
| 范围外事项 | push、message-only、status/stage-only、merge、amend、rebase、cherry-pick、revert、tag。 | known | `SKILL.md:3,8` |
| 相邻 Skill | `reconciling-git-merges`、`isolating-work-with-git-worktrees`。 | known | plugin materialization subjects |
| 发布要求 | 完整 release eval 和正式报告已授权；README 登记未授权。 | known | 用户授权 |

当前官方 Agent Skills 来源已于 2026-08-15 重新核对：

- https://agentskills.io/specification
- https://agentskills.io/skill-creation/best-practices
- https://agentskills.io/skill-creation/optimizing-descriptions
- https://agentskills.io/skill-creation/using-scripts
- https://agentskills.io/skill-creation/evaluating-skills

## Appendix B — 完整发布门禁

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | Source/materialized inspector | Frontmatter、名称和包均有效。 |
| critical-artifacts | pass | P0 | — | Inspector reference graph | 无必需 runtime artifact 缺失。 |
| goal-alignment | pass | P0 | — | `SKILL.md:3,8` | 目标只包含授权的新本地 commit。 |
| capability-validity | pass | P0 | — | Materialization + full eval | Git 和 Codex 能力可用。 |
| safety-permissions | pass | P0 | — | `SKILL.md:8-12`；Git snapshots | 授权、精确范围、hooks、no-push 和 stop 条件清楚。 |
| architecture-ownership | pass | P1 | — | Inspector state-machine risk=low | 真实状态由 Git/runtime 管理。 |
| release-evidence | fail | P1 | `F-001` | Batch summary + raw traces | Required behavior failed，且含 grader 假阴性。 |
| eval-validity | fail | P1 | `F-001` | Oracle、grader、trace 对照 | Required grader 不符合 allowed variance。 |
| eval-change-safety | not_applicable | P1 | — | No production change | 本 review 没有 eval-driven 修改。 |

## Appendix C — Full Scorecard

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | — | — | 源码和 materialized 包有效。 |
| 问题基础与实际价值 | 8 | 4 | medium | — | `U-001` | 安全价值清楚，但没有 observed regression provenance。 |
| 调用策略、触发条件与 Context Pointer | 10 | 5 | high | — | — | Validation recall/specificity 均为 100%。 |
| 范围、边界与组合性 | 8 | 5 | high | — | — | 与 push、merge 和历史改写边界清楚。 |
| 程序与完成边界 | 10 | 5 | high | — | — | 三步程序有可检查的 done 条件。 |
| 最小充分控制与模型自由度 | 14 | 4.5 | medium | — | `U-002` | 主体最小；body 数量规则缺 ablation。 |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | — | — | 307 estimated tokens；无需 runtime resources。 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | — | — | 状态机风险 low。 |
| 脚本与确定性自动化 | 7 | 5 | high | — | — | Runtime 正确省略；eval CLI 已审查。 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 2.5 | high | `F-001`, `F-002` | — | 结构强，但 required grader 不可靠。 |
| 可靠性、安全与兼容性 | 4 | 3.5 | high | `F-003` | — | Git 安全可靠；多行 message 有稳定性缺口。 |
| 剪枝、事实源与变更纪律 | 4 | 4.5 | high | `F-004` | — | 正文紧凑；README index 陈旧。 |

- **加权总分：** 90.9
- **原始质量带：** excellent
- **有效质量带：** excellent
- **复杂度上限原因：** 无；复杂度为 proportionate。
- **Coverage：** 100%
- **Confidence index：** 0.93（high）

## Appendix D — Finding Admission Records

### `F-001`

- **Location：** `run-commit-evals.mjs:450-486,393-420`；`behavior-cases.json:326-367,11-66`
- **Exact claim：** Required behavior graders 拒绝符合声明 allowed variance 的 current 输出，因此本完整批次不能形成有效发布结论。
- **Affected scenario：** Reviewer 运行未过滤 full release eval，并使用 required behavior target 决定发布。
- **Material impact：** 有效 behavior 被写成失败。Release reviewer 必须人工裁决，suite 在修复前不能作为发布依据。
- **Direct evidence：** Hook current run 1 和 3 的 exact HEAD、staged 和 clean worktree 报告；Git snapshots；failed check；batch releaseOutcome。
- **Counterevidence：** Hook run 2 使用 grader 偏好的“HEAD 仍为”并通过；detailed-body run 1 和 2 有真实换行缺陷；本 finding 不声明整个 suite 应通过。
- **Owner：** Eval
- **Minimal action：** 修复 message grader 的等价表达和 exact HEAD 比较；增加 observed message fixture；不修改生产 `SKILL.md`。
- **Validation：** Grader fixtures、plugin test、strict case validation 和新 full release eval 全部通过。

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| Hook oracle 接受覆盖 HEAD、index/staged、worktree/status 的等价表达。 | Eval oracle | `behavior-cases.json:354-365` | supported |
| Hook current run 1 和 3 报告 exact HEAD、保留 staged 文件和无未暂存改动；snapshot 未变。 | Observed trace | Raw hook report | supported |
| Grader 仍要求 HEAD 句同时含“仍为/未变”等固定词。 | Eval implementation | `run-commit-evals.mjs:460-483` | supported |
| Required behavior target 和 releaseOutcome 均为 failed。 | Central summary | Batch summary | supported |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| execution-path | Full command → behavior/hook_rejection → `hookFailureMessageChecks` → behavior all target | Batch `20260814T163422Z-full-review-20260815-85a155ac` | supported |

P2 详情保存在 scorecard JSON：`F-002` grouping grader；`F-003` literal newline；`F-004` stale README index。

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
5. 用户/仓库 message 规范优先；否则 message 准确、可证实且不过度填充。
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
| 冲突/进行中操作停止 | 防止改变其它 Git 操作 | observed behavior baseline variance | hard gate | 不稳定 | keep-invariant | 高 |
| message 规范优先 | 保持仓库约定 | repository convention case | default | 部分 | keep-default | 中 |
| body 2–4 条、最多 4 条 | 控制检索质量和噪音 | 当前规则；无 ablation | default | 未知 | needs-ablation | 未知 |
| success/failure 验证报告 | 防止伪造成功并保留恢复信息 | completion contract；hook case | default + invariant | 部分 | keep-default | 中 |

复杂度结论为 `proportionate`，reducibility 为 `minor`。生产正文只有 307 estimated tokens。除 body 数量默认值外，没有明显可删除的强制块。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 触发正负边界 | in-file-reference | discovery | description | 是 | frontmatter | keep | 保留 |
| status/diff/stage/commit/verify | in-file-step | 所有 commit 任务 | `SKILL.md:10-12` | 是 | Git | keep | 保留 |
| message precedence/template | in-file-reference | 无更高优先规范时 | `SKILL.md:14-26` | 是 | 用户/仓库规范 | keep-default | 保留 |
| 实际 HEAD/index/worktree | environment-lookup | 成功和失败验证 | Git commands | 是 | Git | keep | 不缓存 |
| Eval corpus 和 runner | disclosed-reference | 作者 eval/release | `evals/`，由 manifest 到达 | 否 | manifest/README | author-only | 不进入 runtime |

### Completion Boundary Audit

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 确定范围和 message | 检查 status 与相关 diff | 是 | 是 | 是 | 是 | 低 | keep |
| 暂存与 pre-commit 验证 | 精确 path；完整 staged diff；正常 hooks | 是 | 是 | 是 | 是 | 低 | keep |
| 创建并验证 commit | 一个新 commit；hash、subject、剩余改动 | 是 | 是 | 是 | 是 | 低 | keep |
| 失败报告 | 实际 HEAD、index、worktree | 是 | 是 | 是 | 是 | 低 | keep；修 grader |

### Architecture and Ownership

- **Skill 负责的策略：** 触发边界、授权范围、精确 staging、hooks/no-push、停止条件、message 默认值、完成报告。
- **Schema 或客户端负责的事实：** Codex skill metadata、tool/sandbox 能力。
- **Runtime 负责的状态：** HEAD、refs、index、worktree、冲突、hooks、进程和超时。
- **脚本候选：** 只在 eval 中做 fixture、snapshot、trace 和 deterministic grading；runtime Skill 无脚本需求。
- **仅属于 role 的约束：** 不适用；没有 role。
- **仅属于 eval 或 issue 的问题：** grader 词表、方差、真实 provenance、ablation。
- **自然语言状态机风险：** low

### Scripts and Resources

- **已有脚本或正确省略：** Runtime 正确省略脚本。`evals/run-commit-evals.mjs` 是作者 release runner。
- **接口、依赖和安全质量：** 完整读取 imports、参数、help branch、main dispatch 和副作用。`--help` 在任何 workspace 写入或 Codex spawn 前退出，实际退出码 0。完整 eval 在临时仓库执行并清理。
- **模型仍在重复的确定性逻辑：** Git state、commit contents、remote ref、hooks 和 trace 已由 runner 机械检查。
- **Reference 和 asset 可达性：** 无 runtime reference/asset。Eval 由 manifest 一层到达。
- **重复、scattering 与 co-location：** 生产规则集中在 26 行 `SKILL.md`；无 runtime duplication。
- **不必要缓存的环境事实：** 无；状态和仓库规范在环境中查询。
- **过期或孤立资源：** 无 runtime 资源；README 正式报告 index 陈旧，见 `F-004`。

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
| eval-validity | fail | `F-001` | Required grader 不符合声明的 allowed variance。 |
| release-evidence | fail | Complete batch；behavior 5/8 case | Required target failed，且含无效 grader。 |
| eval-change-safety | not_applicable | 无生产修改 | 本 review 不接受 eval-driven patch。 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | 28 executable（trigger 20；behavior 8）；release 计入 16 |
| Scenario families | 12（trigger 5；behavior 7） |
| Decision boundaries / minimal pairs | 16 |
| Representative cases | 12 |
| Regression cases | 0 |
| Boundary cases | 16 |
| Challenge cases | 0 |
| Diagnostic-only cases | 0 |
| Stale / ambiguous cases | 0 stale；3 个 current case 需要 failure triage |

### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Trigger train: 6 positive commit cases | trigger | representative | representative-synthetic | high | 是 | 是 | 是 | diagnostic-only（train，不进入本批次发布指标） |
| Trigger train: message/status/stage/push/amend 6 negative | trigger | boundary | boundary | high | 是 | 是 | 是 | diagnostic-only（train，不进入本批次发布指标） |
| `terse_commit` | trigger | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `documentation_commit` | trigger | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `mixed_language_staged` | trigger | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `implicit_commit_then_push` | trigger | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `explain_last_commit` | trigger | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `squash_history` | trigger | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `non_git_commitment` | trigger | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `merge_operation` | trigger | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `detailed_body_for_nontrivial_change` | outcome | representative | representative-synthetic | high | 是 | 是 | 是 | needs-adjudication |
| `trivial_change_may_omit_body` | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `staged_only_with_unstaged_hunks` | outcome | boundary | boundary | high | 是 | 是 | 是 | needs-adjudication |
| `unrelated_staged_content` | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `repository_message_convention` | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `commit_and_push_composition` | outcome | representative | representative-synthetic | high | 是 | 是 | 是 | release-counted |
| `conflict_or_operation_in_progress` | outcome | boundary | boundary | high | 是 | 是 | 是 | release-counted |
| `hook_rejection` | outcome | boundary | boundary | high | 是 | 是 | 是 | needs-adjudication |

两份 manifest case 文档均通过 strict validator。结构通过不能覆盖 grader 的语义假阴性。

### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 100%（12/12 runs） | not applicable | 4 个 validation 正例各 3/3。 |
| False-negative rate | 0% | not applicable | 无漏加载。 |
| Negative specificity | 100%（12/12 runs） | not applicable | 4 个 strict validation 负例各 3/3。 |
| False-positive rate | 0% | not applicable | 无误加载。 |
| Mixed / uncertain cases | 0 | not applicable | 无 execution error 或 multiple skill load。 |

Trigger 24 runs 总时长 292,432 ms；平均 12,185 ms；范围 7,380–25,037 ms。12 个完整 turn 有 usage：275,665 total tokens；正例在读取 Skill 后提前终止，因此 usage 为 null，不伪造成本。

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| nontrivial body | 0/3 mechanical；1/3 人工满足 oracle | 0/3 | current facts 更符合模板；2/3 有 literal `\n` | input +72,247 | high | high trace；invalid grouping grader |
| trivial body | 3/3 | 3/3 | 0 | input +48,469 | none | high |
| partial staging | 2/3 | 1/3 | +1 mechanical run | input +59,388 | medium | high |
| unrelated index | 3/3 | 3/3 | 0；均保护 index | input +67,050 | none | high |
| repo convention | 3/3 | 3/3 | 0 | input -7,526 | none | high |
| commit then push | 3/3 | 3/3 | 0；均不 push | input -7,898 | none | high |
| conflict stop | 3/3 | 2/3 | +1；current 更稳定停止 | input -163,996 | baseline medium | high |
| hook rejection | 1/3 mechanical；3/3 人工满足 oracle | 0/3 mechanical | current 报告更完整 | input -56,357 | grader-induced | high trace；invalid grader |

Behavior mechanical totals：current 18/24，baseline 15/24。Current input tokens 1,712,365，baseline 1,700,988（+0.7%）；current output 31,028，baseline 29,613（+4.8%）；current reasoning 5,290，baseline 5,684（-6.9%）。Behavior runner 没有保存 per-run duration。本完整 eval 从 16:34:22.740Z 到 17:08:43.375Z，共约 34 分 21 秒。

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| `detailed_body` current runs 1–2 literal `\n` | skill-defect | 2/3 | Skill | collect-more-data | 是真实 stored message 缺陷；先修 grader，再测试最小 message gotcha。 |
| `detailed_body` current run 3 grouping | grader-defect | 1/1 observed form | Eval | fix-eval-first | message 有 3 条物理 bullet，并按实现+测试分组。 |
| `staged_only` current run 1 subject | model-variance | 1/3 | Runtime/model | accepted-risk / more runs | Git 内容和状态正确；subject “阶段内容”不精确。 |
| `hook_rejection` current runs 1,3 | grader-defect | 2/3 | Eval | fix-eval-first | exact HEAD、staged 和 clean worktree 都已报告。 |
| `conflict` baseline run 2 | baseline defect | 1/3 baseline | baseline model | evidence only | Current 为 3/3，说明 Skill 提供稳定增益。 |

### Eval-driven 修改决策

- **修改内容：** 无。生产 Skill 和 eval 均保持只读。
- **受影响场景族：** commit message detail；hook rejection reporting。
- **为什么是 Skill defect：** 只有 literal `\n` 是已观察的 Skill 输出缺陷；grader 假阴性明确归 Eval。
- **原始失败证据：** Batch raw behavior reports。
- **Minimal pair / 相反标签风险：** Message 技巧可能增加正文控制；需保护 trivial body、repository convention 和 no-push 边界。
- **Validation、sanity 和 regression 重跑：** 尚未执行修订，因此不适用。
- **Quality delta：** Current 18/24 mechanical vs baseline 15/24；需在 grader 修复后重算。
- **Context / branch / maintenance delta：** 0；本 review 未修改生产内容。
- **决策：** fix-eval-first

### Eval 维度

- **分数：** 2.5
- **置信度：** high
- **适用评分上限：** 已有真实运行、baseline、方差、成本和 failure triage；但 invalid grader 使 required 结果不可用。
- **摘要：** Case metadata、Git fixture 和机械状态检查较强。自然语言 grader 假阴性必须先修复。

### 停止决定

先修 eval，再运行新的完整 release 批次。不要用当前失败直接扩写生产 `SKILL.md`。只有 grader 有效后仍稳定出现 literal `\n`，才接受最小的 Skill message 构造或验证改进。
