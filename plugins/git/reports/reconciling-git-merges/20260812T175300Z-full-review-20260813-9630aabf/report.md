# reconciling-git-merges Skill 评审报告

## 结论

- **Skill：** `reconciling-git-merges`
- **模式：** full
- **方向：** aligned
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 83.3 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.89）
- **一句话结论：** Skill 本体边界、触发和最小控制良好；发布阻断来自行为 eval runner 无权写临时仓库 `.git`，不是需要给 Skill 追加文字的行为缺陷。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 协调 Git merge 中双方文本或语义意图，并验证组合结果 | known |
| 已观察失败 | full eval 中 3 个写行为 case 因 `.git` 权限失败；3 个正路由 case 各有 1 次 post-load timeout | known |
| 成功标准 | 保护无关本地工作，依据一手证据保留双方意图或暴露待决问题，验证组合结果，仅按授权完成 merge | known |
| 目标环境或客户端 | AW Codex project/user materialization；Codex command/trigger eval；Claude 仅确定性 bundle 证据 | known |
| 范围外事项 | fast-forward、already up to date、rebase、cherry-pick、明显独立 clean merge、未授权 push | known |
| 相邻 Skill | `git-commit` | known |
| 发布要求 | project/user materialization、validation router、四个 command behavior cases 均 complete/pass | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、static diagnostics、materialization | 包和 final artifacts 有效 |
| critical-artifacts | pass | P0 | — | fixtures、manifest、runner 枚举与解析 | 所有声明 artifact 存在；可执行性问题归 release-evidence |
| goal-alignment | pass | P0 | — | `SKILL.md:5-14`、analysis trace | 依据证据协调意图并在无法裁决时停止 |
| capability-validity | pass | P0 | — | production Skill 只依赖 Git/test | eval-only sandbox mismatch 不代表 production capability 不存在 |
| safety-permissions | pass | P0 | — | analysis-only current case 全部通过 | 未授权副作用、无关修改和 push 有明确边界 |
| architecture-ownership | pass | P1 | — | state-machine risk low | Git/runtime 维护状态，Skill 不模拟生命周期 |
| release-evidence | fail | P1 | F-GM-001 | required behavior suite 失败 | runner 无法产生其 assertions 要求的 Git 状态 |

## 优点

- 所有 21 次 validation route 判断正确：三个语义 merge 正例各 3/3 只加载本 Skill，三个负例 9/9 不加载，普通本地 commit 3/3 只加载相邻 `git-commit`，没有 multiple loads。
- analysis-only dirty-worktree current case 完全通过：识别跨文件单位契约、提出 `/100` 边界修复与测试方案，并保持 HEAD、refs、index、status、diff 不变。
- 写行为 traces 即使被权限阻断，current 仍识别了 7/90 天不可裁决、同文件 fast path/hook 组合，以及跨文件 cents/dollars 修复；没有观察到 Skill 指令导致的危险决策。
- runtime 正文约 303 tokens，五步方法紧凑，无 reference sprawl 或自然语言状态机。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-GM-001 | P1 | observed, structural | scripts | `evals/run-merge-evals.mjs:215-219,279-297` | `ambiguous_retention` 必须产生未提交冲突；两个 semantic cases 必须产生双父 merge commit | runner 固定内层 `--sandbox workspace-write`；trace 报 `.git/ORIG_HEAD.lock Operation not permitted`；current/baseline 同样失败；仅 analysis-only 通过 | outer eval 是 managed Full Access；模型给出正确语义判断和通过测试，但均不能替代 required Git state；deterministic plugin test 不执行内层模型写 `.git` | Script | 在隔离临时 repo 中给内层 Codex 可写 `.git` 的明确权限，同时保留 source repo 完整性和 process isolation；不要改 Skill 文本 | 四个 behavior cases 重跑：ambiguous 留 `UU retention.py` 且无新 commit；两个 semantic 生成双父 commit 且 tests pass；analysis-only 完全不变 |

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-GM-002 | P2 | observed | evals | `evals/manifest.json:23-36` 和 router report | `source_08/09/10` 均 3/3 正确加载，但各 1 次在加载后达到 180 秒 timeout，导致 suite 4/7 complete | 在保留 multiple-load 断言的同时，在路由已确定后终止；或使用更小的 no-op fixture/适配 timeout |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GM-001 | problem_value | 没有 production failure 或成功 current/baseline 证明增量价值 | 修 runner 后比较 current 与 baseline，或提供生产 trace |
| U-GM-002 | instruction_design | current 未在有效权限下完成真实 merge commit | 可写 repo 中完整执行两个 semantic cases |
| U-GM-003 | minimum_control | ablation 不可判定；唯一有效 analysis case current/baseline 都通过 | 修 runner 后逐行为块 ablation |
| U-GM-004 | evals | write cases 排除权限失败后仍无有效 current/baseline 增益结论 | 修 runner 并比较质量、pass rate、time、variance |
| U-GM-005 | reliability | 成功解决冲突并完成 merge 未在 Codex 证明；Claude 无模型证据 | corrected Codex behavior suite；若声明 Claude 行为则另补证据 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | validator、final artifacts | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 3.5 | medium | 4 个 Git fixtures | — | U-GM-001 | 问题真实，增量价值待证 |
| 调用策略、触发条件与 Context Pointer | 10 | 5 | high | 21/21 route decisions | — | — | 精确且可组合 |
| 范围、边界与组合性 | 8 | 5 | high | description、相邻 routing | — | — | 范围清楚 |
| 程序与完成边界 | 10 | 4 | medium | 五步流程、analysis trace | — | U-GM-002 | 清楚但完成路径待证 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | 下述 audit | — | U-GM-003 | proportionate |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | 303 tokens，无 runtime reference | — | — | 紧凑正确 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | state-machine risk low | — | — | 职责正确 |
| 脚本与确定性自动化 | 7 | 2 | high | inner sandbox 与 Git assertions 矛盾 | F-GM-001 | — | runner 不可完成核心合同 |
| 评测、验证与证据驱动迭代 | 9 | 2.5 | high | router incomplete；behavior 1/4 | F-GM-002 | U-GM-004 | 设计丰富，证据无效/不完整 |
| 可靠性、安全与兼容性 | 4 | 4 | medium | build、双平台 deterministic、analysis preservation | — | U-GM-005 | fail-closed 良好，成功路径待证 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | 短正文、无重复/缓存 | — | — | 维护负担低 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| description 正分支 | 完整 merge reconciliation workflow | merge 冲突/进行中，或 clean merge 组合相关行为、契约、依赖 | 是 | 否 | 否 | 三个正例 9/9 只加载本 Skill | 保留 |
| description 负分支 | 普通 Git workflow | fast-forward、already up to date、明显独立 clean merge | 是 | 否 | 否 | validation negatives 均不加载 | 保留 |
| 正文 step 1 stop pointer | 停止使用本 Skill | 运行后发现 fast-forward/already-up-to-date | 是 | 否 | 否 | train corpus 设计；validation 含 pull ff-only | 保留 |
| `agents/openai.yaml` default_prompt | 显式调用 | 用户选择 `$reconciling-git-merges` | 是 | 否 | 否 | metadata/materialization | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 改变任何内容前确认 merge 源、目标、当前状态、用户授权和无关本地工作。
2. analysis-only 不改变 refs/index/worktree；fast-forward 或 already-up-to-date 时停止使用本 Skill。
3. 用 commits、tests、code 和关联 requirement 作为文本/语义交互的一手证据。
4. 兼容时保留双方意图；证据无法裁决不兼容意图时暴露待决问题，不发明行为。
5. 只做具体交互需要的 integration changes，并用项目检查和针对性测试验证组合结果。
6. 仅在用户要求、无 unresolved items 且 required checks 通过时 stage/complete；不带无关工作，不隐式 push。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 5 | low-medium；merge 是高风险、多阶段任务 |
| Hard gates | 3：analysis-only、证据不足待决、完成需授权+验证 | low；均有 fixture/安全依据 |
| Fixed intermediate artifacts | 0 | none |
| Prohibitions | 不丢弃/覆盖/混入本地工作，不发明行为，不未授权完成/push | low；安全不变量 |
| Conditional branches | fast-forward stop、兼容/不兼容、analysis/execute | medium；均是目标任务的真实 branch |
| Fixed output fields | 0 | none |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 状态/历史/本地工作检查 | 防止操作错对象和混入 local work | destructive Git risk、analysis fixture | invariant | 部分 | keep-invariant | refs 或用户工作被污染 |
| fast-forward/already-up-to-date stop | 避免过宽触发 | routing contract | invariant | 部分 | keep-invariant | Skill 劫持普通 merge |
| 一手证据与跨文件追踪 | 捕获 semantic merge | fixtures | default | 部分 | keep-default | clean merge 行为回归漏检 |
| 兼容保留双方；无法裁决则提问 | 防止单边覆盖或发明政策 | ambiguous retention case | invariant | 部分 | keep-invariant | 丢失意图或编造折中 |
| 只做 integration change | 限制范围 | surgical merge goal | default | 是 | keep-default | 无关重构扩大风险 |
| 项目+针对性测试 | 验证组合行为 | same/cross-file cases | invariant | 部分 | keep-invariant | 单边 tests 无法证明组合正确 |
| 授权+验证后完成，不 push | 控制副作用 | user boundary | invariant | 部分 | keep-invariant | 越权提交或推送 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 五步协调方法 | in-file-step | 所有目标 merge reconciliation | `SKILL.md` | 是 | description | keep | 保留 |
| fast-forward stop | in-file-reference | 状态检查后 | step 1 | 否 | description/step 1 | keep-invariant | co-located 正确 |
| commits/tests/code/PR/issue | environment-lookup | 证据搜集 | repository/environment | 是 | step 2 | keep-default | 不缓存内容 |
| fixtures/corpora/runner | disclosed-reference | 作者 eval | `evals/` | 否 | manifest/README | eval-only | 不进入 runtime |
| Git merge state | environment-lookup | 当前操作 | Git | 是 | step 1 | keep-invariant | Runtime 为事实源 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 看清 merge | 已确认状态、历史、源/目标和 local work；analysis-only 不变 | 是 | 是 | 是 | 是 | low | 保留 |
| 找依据/协调意图 | 每个文本/语义冲突有一手证据；不能裁决则显式待决 | 是 | 部分 | 是 | 是 | medium | 保留，依赖 trace/测试 |
| 验证组合 | required checks 和交互测试通过；新问题已处理 | 是 | 是 | 是 | 是 | low | 保留 |
| 完成 merge | 用户要求、无 unresolved、required checks pass | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 触发边界、证据优先、双方意图协调、验证和授权完成原则。
- **Schema 或客户端负责的事实：** invocation policy、tool 参数与返回。
- **Runtime 负责的状态：** MERGE_HEAD、unmerged entries、refs/index/worktree、Git write permissions。
- **脚本候选：** command eval runner 和 mechanical assertions；不是 production state machine。
- **仅属于 role 的约束：** display/short description/default prompt/implicit invocation。
- **仅属于 eval 或 issue 的问题：** inner sandbox、trigger post-load timeout、fixture assertions、ablation。
- **自然语言状态机风险：** low

## 脚本与资源

- **已有脚本或正确省略：** production runtime 正确无 script；eval 有 383-line command runner。
- **接口、依赖和安全质量：** runner 有 `--help`、positive integer 校验、临时 repo、source/fixture path 限制、cleanup、current/baseline 和机械 checks；但固定内层 `workspace-write` 与 `.git` write assertions 不相容。
- **模型仍在重复的确定性逻辑：** merge state 和 tests 已由 Git/Python scripts 检查。
- **Reference 和 asset 可达性：** 四个 fixture 从 `evals.json` 到达；无路径逃逸，bundle verify 通过。
- **重复：** runtime 无重复；eval prompts 与 corpus 有合理测试重复。
- **Scattering 与 co-location：** behavior assertions 集中在 runner；fixtures 与 cases 同层。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** 无；但三项 write fixtures 目前无法生成有效证据。

## 评测与证据

- **Trigger eval 与触发率：** 路由选择 21/21 正确，multiple loads 0；因 3 次 post-load timeout，case complete 为 4/7，suite incomplete。
- **Behavior 或 regression eval：** current/baseline 各运行四个 case；analysis-only 双方通过。其余三项双方被 `.git` 权限阻断，不能解释为 Skill failure 或增益。
- **Runtime trace：** Codex 0.147.0、`gpt-5.6-luna`、outer process managed；完整 traces 已读取。
- **基线：** owner Skill removed，companion `git-commit` retained。
- **Ablation 或 no-op 证据：** analysis-only current/baseline 都通过；write cases 被 runner 权限混淆，因此结果未知。
- **Token、时间和方差成本：** 正例 routing 可达 69–180 秒，post-load execution 偏重；behavior current/baseline 总体约 14 分钟。
- **发布仍缺少的证据：** 修复 runner 后行为 4/4 complete/pass；router 7/7 complete。

## 最小改进路线

### 现在——发布阻断

1. 修复 `run-merge-evals.mjs` 的内层 Git 写权限模型；只改 eval runner，不改 Skill。
2. 重跑完整 behavior suite，确认三种 write state 的 mechanical assertions 和 analysis-only 不变量。

### 下一步——高价值质量改进

1. 让 trigger harness 在路由结论充分时及时结束，消除 post-load timeout；保留 multiple-load 检查。
2. 有效行为证据后再判断五个行为块是否需要 ablation 或缩短。

### 以后——启发式、评测或产品/runtime 工作

1. 若要宣称 Claude 模型行为，建立独立 Claude behavior evidence；当前只证明 bundle/静态合同。

## 停止决定

现在停止评审并阻断发布证据门禁。证据明确指向 eval Script owner；在 runner 修复并产生新 observed evidence 前，不应修改 Skill 正文，也不应重复运行同一无效 write suite。
