# isolating-work-with-git-worktrees Skill 完整评审报告

## 结论

- **Skill：** isolating-work-with-git-worktrees
- **模式：** full
- **方向：** aligned
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 83.5 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.86）
- **一句话结论：** Skill 的隔离模型和安全边界正确；发布阻断来自 test-command trace parser 的确定 false negative，另有 full-clone 过触发和 ignore 检查不充分两个 P2。

正式 eval 批次：20260813T174305Z-full-review-20260814-1ad1dcee。模型运行：20260813T174436Z-6fc1c2e1。补充 default-path 方差批次：20260813T182241Z-full-review-20260814-default-path-variance-d036b962。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 在需要独立 checkout 时保护当前工作区，并提供可验证的 linked-worktree 工作环境 | known |
| 已观察失败 | sanity 7/10，behavior 3/4；补充 current 三次语义均正确但一次被 trace parser 拒绝 | known |
| 成功标准 | 正确选择或复用隔离、保护原工作区、使用正确路径/基点/分支、运行基线、准确交付 | known |
| 目标环境或客户端 | AW Codex project/user materialization；Codex router/command eval；双平台确定性插件测试 | known |
| 范围外事项 | 同 checkout 普通任务、只读检查、例行 worktree 管理、需要独立 refs/对象库的 full clone | known |
| 相邻 Skill | reconciling-git-merges、git-commit | known |
| 发布要求 | project/user materialization、validation、sanity 和四个 behavior cases 在同一批次完成 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、static inspector、双 scope materialization | 包和最终制品有效 |
| critical-artifacts | pass | P0 | — | Skill、metadata、manifest、router corpora、runner | 所有声明 artifact 存在并已检查 |
| goal-alignment | pass | P0 | — | Skill 正文和 behavior traces | 保护原工作区并保持任务隔离 |
| capability-validity | pass | P0 | — | Git worktree 和 independent clone 边界 | 能力真实且可执行 |
| safety-permissions | pass | P0 | — | no stash/reset/discard/force，cleanup 条件 | 安全边界明确 |
| architecture-ownership | pass | P1 | — | Git 和平台分别拥有状态与生命周期 | 无 prose state machine |
| release-evidence | fail | P1 | F-WT-003 | required batch 机械失败，补充正确运行仍可被拒绝 | 当前 behavior oracle 不可靠 |
| eval-validity | fail | P1 | F-WT-003 | node test.mjs command event、marker、exit 0 与空 parser 结果并存 | 确定 false negative |
| eval-change-safety | not_applicable | P1 | — | 本轮没有修改 Skill 或 eval | 无 eval-driven change |

## 优点

- validation 6/6 cases、18/18 route decisions 通过。核心正负边界精确。
- 四个 behavior case 覆盖 dirty workspace、未忽略默认根、已有隔离复用和失败基线。正式批次其余三项通过。
- default-path 补充 current 三次均保护原 main、基于 origin/main 创建 hotfix-login、使用仓库内 .worktrees 路径、修改正确并运行测试。owner-removed baseline 0/3。
- Skill 明确区分 linked worktree 与独立 clone，也明确平台隔离只有在独立 refs 和对象库得到验证时才等价。
- 不允许 stash、reset、discard、force 或隔离失败后静默回退。清理需要用户要求且无未保存工作。
- 正文只有四个阶段，没有 runtime script、reference sprawl 或自然语言状态机。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-WT-003 | P1 | observed, structural | scripts | scripts/eval-git-trace.mjs:63-67,103-113；skills/isolating-work-with-git-worktrees/evals/run-worktree-evals.mjs:329-356,459-474 | 正确 default-path 执行可被计为 behavior failure | 补充 current run 2 的 command_execution 明确包含 node test.mjs，退出 0；测试 marker 存在、app 正确、main 不变；grader 仍返回 requested_test_commands=[] | 另外两次使用较简单 quoting 的运行通过；普通 command parser 单测通过 | Script | 修复 nested shell quoting 的 unwrap/parser，或使用不依赖外层 balanced quote 的结构化证据；加入原始 command string 正回归 | 先跑 evals.test.mjs，再重跑四个 behavior cases；所有语义正确 current 必须机械通过 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-WT-001 | P2 | observed | triggering | SKILL.md:3 | sanity_full_clone 3/3 加载本 Skill；读正文后均正确选择 clone，未观察到不安全 worktree 动作 | 将 independent refs/object-store 的排除条件前移，并直接指向 repository-level isolation |
| F-WT-002 | P2 | observed, structural | instruction_design | SKILL.md:8 | 正式 default-path current 只检查不存在的 .worktrees 目录，误判现有 .worktrees/ ignore rule 不生效并停止 | 明确检查候选子路径，例如 .worktrees/.probe；同时保留真正未忽略时的 fail-closed |
| F-WT-004 | Advisory | observed | scripts | run-worktree-evals.mjs:490-501 | baseline 可在 /private/tmp 创建 runner temp root 之外的固定 worktree；后续运行看见旧路径 | 限制 child 可写临时位置到 per-run root，或登记并清理外部 linked worktree |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-WT-001 | problem_value | 没有生产使用分布说明隔离防止实际损坏或返工的频率 | 收集匿名 activation、reuse、fallback 和 blocker 类别 |
| U-WT-002 | triggering | reuse 仅 1/3 load；merge sibling 一次 extra git-commit load，稳定性未定 | 修 grader 后增加重复运行，并让 router 在判定充分后及时结束 |
| U-WT-003 | minimum_control | 没有 ablation 单独证明 default path、ignore、baseline 和 lifecycle 控制 | 比较 current、minimal-contract 和 owner-removed |
| U-WT-004 | evals | trigger corpus 缺 strict admission metadata，且没有修正后的完整批次 | 补 metadata、修 oracle、重跑 5/5 targets |
| U-WT-005 | reliability | Claude 只有包级证据；Codex 路由和 default-path 有方差 | 重跑 corrected Codex；仅在声明跨模型行为时跑 Claude |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | validator、materialization、static inspector | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 4.5 | medium | default-path current 3/3 vs baseline 0/3 | — | U-WT-001 | 强合成价值 |
| 调用策略、触发条件与 Context Pointer | 10 | 3.5 | medium | validation 6/6；sanity 7/10 | F-WT-001 | U-WT-002 | 有一个稳定过触发 |
| 范围、边界与组合性 | 8 | 5 | high | worktree、clone、sibling 边界 | — | — | 静态边界正确 |
| 程序与完成边界 | 10 | 4 | high | 四阶段流程、ignore 误判 trace | F-WT-002 | — | 一个 Git gotcha 未说明 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | 风险映射、短正文 | — | U-WT-003 | proportionate |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | 单一 runtime 文件 | — | — | 紧凑完整 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | Git/platform 是事实源 | — | — | low risk |
| 脚本与确定性自动化 | 7 | 2.5 | high | trace false negative、外部 temp residue | F-WT-003, F-WT-004 | — | release grader 需修复 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3 | medium | 5/5 targets、baseline、variance、invalid oracle | — | U-WT-004 | 覆盖强，结论不可发布 |
| 可靠性、安全与兼容性 | 4 | 4 | medium | workspace preservation、双平台 deterministic | — | U-WT-005 | 安全强，方差可见 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | 四阶段短正文 | — | — | 维护成本低 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 重复同义 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| description 正分支 | 完整 isolation workflow | 显式 worktree、保护当前工作、并行分支 | 是 | 否 | 否 | validation positives 9/9；sanity owner positives 13/15 | 保留 |
| description reuse branch | 复用已有 isolation | 环境已提供满足要求的隔离 | 是 | 否 | 否 | sanity 1/3 load；behavior reuse pass | 保留并增加路由方差证据 |
| description current-checkout 负分支 | 当前 workspace | 无独立 checkout 需求 | 是 | 否 | 否 | dirty same-branch 3/3 no-load | 保留 |
| description full-clone 负分支 | repository isolation | 需要独立 refs/objects | 是，但位置靠后 | 否 | 否 | 3/3 over-load | 前移排除条件 |
| agents/openai.yaml default prompt | 显式调用 | 用户选择该 Skill | 是 | 否 | 否 | materialization 通过 | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在需要独立 Git 工作目录时启用；可用隔离满足要求时复用。
2. linked worktree 共享 objects/多数 refs；仓库级隔离使用独立 clone。
3. 手动创建前确认路径约定、候选子路径 ignore、基点、分支和目标。
4. 不 stash、reset、discard、force；创建失败不得静默回退。
5. 开工前确认隔离 path/base/branch/state，并运行任务所需基线。
6. 修改只保留在隔离工作区，并准确报告 path、branch 和 pre-existing failure。
7. 平台管理生命周期；手动移除只在用户要求且无未保存工作时执行。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 4 | medium；worktree 创建有多个状态边界 |
| Hard gates | 4：隔离层级、ignore、无破坏 fallback、cleanup | low；均是安全门禁 |
| Fixed intermediate artifacts | 0 | none |
| Prohibitions | stash/reset/discard/force、修改 gitignore、静默回退、直接删目录 | low |
| Conditional branches | reuse/platform/manual、project/default path、worktree/clone、baseline pass/fail | medium；均是真实 branch |
| Fixed output fields | path、branch、baseline status | low |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| worktree/clone 边界 | 选择正确隔离层级 | Git shared-state semantics、full-clone case | invariant | 部分 | keep-invariant | 破坏性实验共享 refs/objects |
| reuse first | 避免重复隔离 | reuse fixture | default | 是 | keep-default | 冗余 worktree 和 branch 冲突 |
| project/default path | 统一位置 | user/project convention | default | 部分 | keep-default | 路径散落 |
| candidate child ignore check | 正确识别 .worktrees/ rule | observed formal failure | invariant detail | 否 | keep-invariant | 错误阻断或污染 status |
| no state-destructive fallback | 保护当前工作 | dirty workspace fixtures | invariant | 部分 | keep-invariant | 用户未完成工作被改变 |
| trusted start and baseline | 区分已有失败 | baseline fixture | default | 部分 | keep-default | 错误归因 |
| lifecycle rule | 避免删除有工作目录 | Git safety | invariant | 部分 | keep-invariant | 未保存工作丢失 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 四阶段方法 | in-file-step | 所有目标 isolation | SKILL.md | 是 | description | keep | 保留 |
| worktree/clone semantics | in-file-reference | boundary selection | step 1 | 是 | Git/runtime | keep-invariant | 保持同文件 |
| project path、Git state、ignore | environment-lookup | manual creation | repository | 条件性 | step 2 | keep | 不缓存 |
| platform isolation/lifecycle | environment-lookup | platform branch | runtime | 条件性 | steps 1/4 | keep | 平台为事实源 |
| eval corpora/runner | disclosed-reference | 作者评测 | evals/ | 否 | manifest | eval-only | 不进入 runtime |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 确认隔离边界 | 已判断 reuse、worktree 或 clone | 是 | 是 | 是 | 是 | low | 保留 |
| 安全创建 | path/base/branch/ignore 已确认，原 workspace 不变 | 部分 | 是 | 是 | 是 | medium | 补 candidate child ignore |
| 可信起点 | path/base/branch/state 和 baseline 已核对 | 是 | 是 | 是 | 是 | low | 保留 |
| 保持隔离与交付 | 修改只在隔离内，报告 path/branch；cleanup 条件满足 | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 触发、隔离层级、复用、安全创建、可信起点和交付边界。
- **Schema 或客户端负责的事实：** 注册、显式 invocation、platform capability 描述。
- **Runtime 负责的状态：** linked worktree、branch、refs、objects、index、workspace 和 lifecycle。
- **脚本候选：** eval trace parser 和 fixture cleanup；production 无需 script。
- **仅属于 role 的约束：** short description 和 default prompt。
- **仅属于 eval 或 issue 的问题：** trace parsing、temp residue、case metadata、方差采样。
- **自然语言状态机风险：** low。

## 脚本与资源

- **已有脚本或正确省略：** production 正确无 script；eval runner 有 isolated fixture、snapshot、prohibited-command checks、current/baseline 和 cleanup。
- **接口、依赖和安全质量：** final Git state checks 强；nested shell command parser 产生 F-WT-003。
- **模型仍在重复的确定性逻辑：** Git 提供 worktree/ref/status；正文不复制。
- **Reference 和 asset 可达性：** 无 runtime reference；eval assets 从 manifest 到达。
- **重复与 scattering：** runtime 无重复；共享 command parser 正确 co-locate 在 plugins/git/scripts。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** 未发现；外部 /private/tmp residue 是 cleanup 风险，不是 production asset。

## Eval Case Audit

### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | critical | behavior corpus policy |
| False-negative cost | high | 漏隔离可污染当前用户工作 |
| False-positive cost | high | 多余隔离可阻断任务或选择错误隔离层级 |
| Policy rationale | 两类错误都直接影响工作区安全和完成能力 | evals.json |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | F-WT-003 | required scenario 的正确 test execution 被拒绝 |
| release-evidence | fail | formal 5/5 complete，mechanical failed | oracle defect 使结果不可发布 |
| eval-change-safety | not_applicable | 无修改 | 本轮只评审和发布报告 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Router corpus | 30：train 14、validation 6、sanity 10 |
| 本次 router cases | 16，三次每 case |
| Behavior cases | 4 |
| Behavior scenario families | 3 |
| Representative cases | 1 |
| Boundary cases | 3 |
| Regression / challenge / diagnostic-only | 0 / 0 / 0 |
| Stale cases | 0 |
| Ambiguous cases | reuse 与 merge sibling routing 需要更多 runs |

### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| preserve_dirty_workspace_and_use_default_path | outcome | representative | synthetic | high | 是 | 是 | 是 | release-counted；grader 先修 |
| stop_when_default_root_not_ignored | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| reuse_existing_isolation | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| report_dirty_baseline | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| router validation/sanity groups | routing | 未声明 | corpus | unknown | 部分 | 部分 | 是 | needs-adjudication metadata |

### Trigger 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 91.7%（22/24） | 未提供 | 两个 miss 均为 reuse case |
| False-negative rate | 8.3% | 未提供 | reuse loaded 1/3 |
| Negative specificity | 87.5%（21/24） | 未提供 | 三个 false positive 均为 full-clone |
| False-positive rate | 12.5% | 未提供 | body 后续正确转向 clone |
| Mixed / uncertain cases | reuse、merge-conflict sibling | — | route stability 需更多证据 |

validation 单独为 18/18 exact。sanity 为 24/30 decision-level exact，7/10 case-level pass。

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| default manual creation | formal 误停；补充语义 3/3，机械 2/3 | 补充 0/3 | 强正向，但 parser 混淆 | 未归一 | observed 1/4 model error，1/3 grader error | high |
| unignored blocker | pass | baseline 不作为发布目标 | 正确 fail-closed | 未归一 | 单次 | high |
| reuse existing isolation | pass | mixed | 正向 | 未归一 | 单次 behavior | high |
| dirty baseline | pass | mixed | 正向 | 未归一 | 单次 | high |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| full-clone owner load | skill-defect，P2 trigger | 3/3 | Skill | narrow pointer | description exclusion 不够前置；行为仍安全 |
| reuse owner miss | model-variance / insufficient-runs | 2/3 | unknown | collect-more-data | behavior 可正确完成，load 方差大 |
| formal default ignore check | skill-defect，P2 instruction | 1/4 reviewed | Skill | minimal clarification | nonexistent directory 的 Git ignore gotcha |
| supplemental runs_requested_test | grader-defect | observed | Script | fix-eval-first | command、marker、exit 和 state 均证明执行 |
| merge-conflict extra git-commit | model-variance | 1/3 | unknown | collect-more-data | owner worktree 正确 no-load |
| /private/tmp stale paths | fixture/runtime isolation defect | observed | Script | contain temp writes | cleanup 不覆盖外部路径 |

### Eval-driven 修改决策

- **修改内容：** 无。
- **受影响场景族：** 无 Skill 或 eval 改动。
- **为什么是 Skill defect：** 仅 F-WT-001 和 F-WT-002 有 observed Skill 证据；P1 是 Script defect。
- **Minimal pair / 相反标签风险：** full-clone exclusion 不能损害 explicit worktree positives；ignore clarification 不能放过真正未忽略 case。
- **决策：** fix-eval-first。

### Eval 维度

- **分数：** 3 / 5
- **置信度：** medium
- **适用评分上限：** invalid release grader 和缺失 admission metadata 限制结论。
- **摘要：** 覆盖、baseline 和方差扩展充分；当前机械 release outcome 不能直接使用。

### 停止决定

停止增加 Skill 控制。先修 F-WT-003，再以 minimal pairs 验证两个 P2，避免一次性扩写正文。

## 差量与沉积

- **上一版 P0/P1 关闭情况：** 本次 full 不是 delta；不声明关闭。
- **生产变化：** 当前 production bundle 相对 main 无变化。
- **沉积候选：** 只有 candidate-child ignore 是最小新增候选；不应加入具体长命令流程。
- **净变化：** neutral。

## 最小改进路线

### 现在——发布阻断

1. 修复 F-WT-003，加入实际 nested-quote command regression。
2. 封闭或追踪外部临时 worktree，避免 F-WT-004 影响重跑。
3. 重跑完整 behavior、validation 和 sanity suites。

### 下一步——高价值质量改进

1. 对 description 做最小 full-clone 排除前移，并验证 worktree positives 不回归。
2. 在 step 2 加一句 candidate-child ignore 检查，验证 ignored/unignored minimal pair。
3. 补齐 trigger case admission metadata。

### 以后——启发式、评测或产品/runtime 工作

1. router harness 在判定充分后及时结束，以降低 sibling 路由成本和 timeout 噪音。
2. 仅在跨模型行为声明需要时补 Claude model eval。

## 停止决定

当前 full review 已定位一个 P1 Script defect、两个 P2 Skill 问题和一个 cleanup Advisory。继续重复现有 suite 不会提高可信度。正式报告发布后应停止，直到 grader 或目标文本发生最小修订并产生新 observed evidence。
