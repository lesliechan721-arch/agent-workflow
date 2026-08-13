# git-commit Skill 评审报告

## 结论

- **Skill：** `git-commit`
- **模式：** full
- **方向：** aligned
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** provisional
- **加权总分：** 89.2 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.86）
- **一句话结论：** Skill 本体简洁、安全且触发准确；完整 validation 触发评测通过，但当前没有可写 Git 行为 suite，核心 commit 行为仍无真实模型证据，因此不能形成发布通过结论。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 在不污染范围外 index/worktree/history 的前提下，创建用户授权的新本地 commit | known |
| 已观察失败 | 未提供生产失败；portable cases 指向部分暂存、范围外 staged 内容、进行中操作和 hook 拒绝风险 | unknown |
| 成功标准 | 检查范围、精确暂存、正常运行 hooks、创建并验证一个新 commit，报告剩余改动 | known |
| 目标环境或客户端 | AW 插件生成的 Codex project/user Skill；Claude 只有 build 和确定性 bundle 证据 | known |
| 范围外事项 | push、仅拟写/评审 message、仅查看/暂存、merge、amend、rebase、cherry-pick、revert、tag | known |
| 相邻 Skill | `reconciling-git-merges` | known |
| 发布要求 | manifest 要求 project/user materialization 和 project validation trigger；full review 还要求核心行为证据才可给发布通过结论 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、静态诊断、source/final diff | frontmatter、name、metadata 和 materialized profiles 有效 |
| critical-artifacts | pass | P0 | — | 全包枚举、manifest materialization | 声明资源存在且可解析 |
| goal-alignment | pass | P0 | — | `SKILL.md:5-11` | 只创建授权本地 commit，并排除 push 和其它历史操作 |
| capability-validity | pass | P0 | — | Git 工作流和 plugin tests | 核心步骤只依赖普通 Git 能力 |
| safety-permissions | pass | P0 | — | `SKILL.md:5-11`、portable cases | 精确路径、保护范围外状态、hooks、无 push 边界清楚 |
| architecture-ownership | pass | P1 | — | 静态诊断 state-machine risk low | Git 和工具维护真实状态，Skill 只维护策略 |
| release-evidence | unknown | P1 | — | trigger release target 3/3 通过；无 behavior suite | 触发已证明，核心 commit 行为未证明 |

## 优点

- validation 8 个用例全部通过；4 个正例和 4 个 near-miss 负例各运行 3 次，共 24/24 路由判断正确，且 fixture 全程不变。
- 与合并 Skill 的组合评测中，普通本地 commit 3/3 只加载 `git-commit`，没有多 Skill 误加载。
- source 与 project/user final `SKILL.md` 内容一致；作者 validator、Codex/Claude deterministic plugin tests 和构建均通过。
- runtime 正文约 307 tokens，没有 reference sprawl、重复段落或自然语言状态机。

## 必须修复的问题

无已接纳 P0/P1 finding。

## 非阻断问题

无 P2 finding。核心行为证据缺失属于 unknown，不伪装成 finding。

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GC-001 | problem_value | 没有生产失败或 no-Skill baseline 证明增量价值 | current/baseline 可写 commit 对照或确认的生产 trace |
| U-GC-002 | instruction_design | 未观察完整 inspect-stage-hook-commit-verify 路径 | 在隔离可写仓库执行 behavior cases 并读 trace |
| U-GC-003 | minimum_control | 默认 message 模板与 2–4 bullet 规则没有 ablation | 对比当前、缩短版和无模板的 message 准确性与噪音 |
| U-GC-004 | evals | 8 个 behavior cases 仅为 portable specs | 在 manifest 中增加可写 command/conversation suite 并真实运行 |
| U-GC-005 | reliability | 未模型验证部分暂存、hook 拒绝和失败后状态 | 机械比较 HEAD、index、worktree、commit 内容的可写 runner |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | validator、source/final materialization | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 4 | medium | 8 个 portable behavior cases、确定性 Git tests | — | U-GC-001 | 问题具体，增量价值待实证 |
| 调用策略、触发条件与 Context Pointer | 10 | 5 | high | validation 8/8、24/24 | — | — | 边界准确 |
| 范围、边界与组合性 | 8 | 5 | high | description、merge router 相邻 case | — | — | 单一职责且可组合 |
| 程序与完成边界 | 10 | 4 | medium | 三步流程、failure report 合同 | — | U-GC-002 | 清楚但未端到端观察 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | 下述最小控制审计 | — | U-GC-003 | 主体适当，message 细节待 ablation |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | 307 tokens，无 runtime resource | — | — | 紧凑且层级正确 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | state-machine risk low | — | — | 职责正确 |
| 脚本与确定性自动化 | 7 | 5 | high | trigger fixture、plugin tests | — | — | runtime 无需脚本，eval fixture 合理 |
| 评测、验证与证据驱动迭代 | 9 | 3 | medium | trigger 真 eval；behavior portable only | — | U-GC-004 | 触发强，核心行为缺失 |
| 可靠性、安全与兼容性 | 4 | 4 | medium | build、双平台 deterministic、managed eval | — | U-GC-005 | 静态/触发可靠，副作用路径待证 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | 短正文、无重复/缓存 | — | — | 维护负担低 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| frontmatter description | 完整 `git-commit` workflow | 用户要求实际创建新的本地 commit，包括 commit-and-push 的 commit 步骤 | 是 | 否 | 否 | validation 4 类正例 12/12 加载 | 保留 |
| description 负边界 | 不加载该 Skill | message-only、status/stage-only、push-existing、merge/history rewrite 等 | 是 | 否 | 否 | validation 4 类负例 12/12 不加载 | 保留 |
| `agents/openai.yaml` default_prompt | 显式用户调用入口 | 用户选择 `$git-commit` | 是 | 否 | 否 | materialization 与 metadata 校验 | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 仅在用户授权时创建一个新的本地 commit，并严格限制在授权范围。
2. 改变 index 或提交前检查 HEAD、index、worktree 和相关 diff。
3. 保留无关 staged/unstaged 工作；无法安全隔离范围时停止。
4. 有未解决冲突或其它进行中的 Git 操作时，不创建普通 commit。
5. 优先遵守用户或仓库 message 规范；否则使用准确、证据化的默认 message。
6. 正常运行 hooks；提交后验证 commit 和剩余状态，失败时报告真实状态。
7. 本 Skill 不 push。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3：检查、精确暂存/提交、验证 | low；与不可逆历史写入匹配 |
| Hard gates | 2：范围不可隔离；冲突/操作进行中 | low；均为安全边界 |
| Fixed intermediate artifacts | 1：完整 staged diff | low；直接验证提交内容 |
| Prohibitions | 4 类：不改范围外状态、不用 broad add、不绕 hooks、不 push | low；均有清楚失败场景 |
| Conditional branches | 1：仓库/用户 message 规范优先 | low |
| Fixed output fields | hash、subject、剩余改动 | low；可检查且有诊断价值 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 授权范围与保护 index/worktree/history | 防止混入用户工作 | Git 写历史不可逆、portable cases | invariant | 不稳定 | keep-invariant | 提交范围外内容 |
| 冲突/进行中操作停止 | 防止错误普通 commit | Git operation 状态 | invariant | 部分 | keep-invariant | 破坏当前操作语义 |
| 检查→精确暂存→验证 | 确保 commit 内容正确 | completion contract | default | 部分 | keep-default | 隐藏 staged 内容或误报成功 |
| 禁用 `git add ./-A` | 避免 broad staging | exact-scope contract | invariant | 部分 | keep-invariant | 带入无关文件 |
| message 优先级与证据化摘要 | 使 message 合规、可追踪 | repository conventions | default | 是 | keep-default | 违反仓库约定或编造影响 |
| 固定 2–4 bullets、最多 4 | 控制 message 详细度 | 仅 portable spec | default | 是 | needs-ablation | 可能只影响噪音/检索性 |
| 正常 hooks 与提交后状态报告 | 不绕过质量门禁并可恢复 | hook-rejection case | invariant | 部分 | keep-invariant | 伪报成功或丢失恢复信息 |
| 不 push | 保持组合边界 | 相邻外层 workflow | invariant | 部分 | keep-invariant | 越权外部副作用 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 授权、状态检查、暂存、提交、验证 | in-file-step | 所有 commit 创建 | `SKILL.md` | 是 | description | keep | 保留 |
| 默认 message 模板 | in-file-reference | 无用户/仓库规范时 | `SKILL.md` | 否 | Message heading | keep-default | 保留；模板细节待 ablation |
| 仓库 message 规范 | environment-lookup | 仓库存在规范时 | 仓库文件 | 否 | “优先遵守…仓库规范” | keep-default | 不复制到 Skill |
| Git 当前状态和 diff | environment-lookup | 每次 | Git | 是 | 步骤 1–2 | keep-invariant | 保持环境为事实源 |
| behavior cases 和 fixture | disclosed-reference | 作者评测时 | `evals/` | 否 | README/manifest | eval-only | 不进入 runtime |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 确定范围 | 状态和相关 diff 已检查，message 已确定 | 是 | 是 | 是 | 是 | low | 保留 |
| 创建 commit | 只精确暂存，完整 staged diff 已核对，hooks 正常运行 | 是 | 是 | 是 | 是 | low | 保留 |
| 验证与报告 | 新 commit hash/subject 和剩余状态已验证；失败报告真实状态 | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 使用时机、授权范围、精确 staging、message 默认、hooks/no-push 边界。
- **Schema 或客户端负责的事实：** tool 参数、命令返回、Skill invocation 元数据。
- **Runtime 负责的状态：** Git refs、index、worktree、hook 执行和 exit status。
- **脚本候选：** 可写行为 eval runner；不是 production Skill runtime 脚本。
- **仅属于 role 的约束：** `openai.yaml` 的 display、short description、default prompt 和 implicit invocation。
- **仅属于 eval 或 issue 的问题：** 部分暂存、hook rejection、message ablation 的机械 assertions。
- **自然语言状态机风险：** low

## 脚本与资源

- **已有脚本或正确省略：** production runtime 正确省略脚本；eval 使用 isolated trigger fixture。
- **接口、依赖和安全质量：** fixture 清除 host Git 环境、禁用 hooks/GPG、构造 staged/unstaged/untracked 状态并哈希 snapshot；deterministic tests 通过。
- **模型仍在重复的确定性逻辑：** Git 状态检查由命令完成，不需要新增 script。
- **Reference 和 asset 可达性：** runtime 无 references/assets；eval 由 manifest/README 到达。
- **重复：** 无 runtime 重复。
- **Scattering 与 co-location：** message 规则集中于一个 heading。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** behavior cases 尚未进入 executable suite，但明确标为 portable spec，不算隐性发布证据。

## 评测与证据

- **Trigger eval 与触发率：** validation 8/8 cases 通过；24/24 决策正确；正例 12/12 加载，负例 12/12 不加载。
- **Behavior 或 regression eval：** 8 个 portable behavior specs；`pnpm plugin:test git` 验证结构和确定性 Git 合同，但不是模型行为证据。
- **Runtime trace：** Codex 0.147.0、`gpt-5.6-luna`、managed process；trigger trace 无 execution error。
- **基线：** behavior 为 none；trigger 使用 expected routing，不是 no-Skill quality baseline。
- **Ablation 或 no-op 证据：** 无。
- **Token、时间和方差成本：** validation durations 约 6.7–26.9 秒；未形成 behavior 成本数据。
- **发布仍缺少的证据：** 可写 commit runner 的 current/baseline，覆盖 8 个核心行为 case。

## 最小改进路线

### 现在——发布阻断

1. 无 confirmed failure 要求修改 Skill 文本。若要把结论提升为发布通过，先增加隔离、可写且机械检查 Git 状态的 behavior suite。

### 下一步——高价值质量改进

1. 执行部分暂存、范围外 staged 内容、进行中操作、hook rejection 和 commit-and-push composition cases。
2. 对默认 message 模板做最小 ablation，确认 2–4 bullets 是否有净增益。

### 以后——启发式、评测或产品/runtime 工作

1. 仅在声明 Claude 模型行为时，补独立 Claude 行为证据；当前双平台 deterministic bundle test 不能替代模型 eval。

## 停止决定

现在停止。没有 observed、normative 或 structural 证据支持修改 Skill；继续追加规则只会增加 context。下一轮应从可写行为证据开始，而不是重写正文。
