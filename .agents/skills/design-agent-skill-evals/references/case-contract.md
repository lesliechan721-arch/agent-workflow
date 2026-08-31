# 最小 case 合同

写 case/suite 时读取本文件。机器字段与 accepted values 以当前 `aw skill eval prepare --help` 和 `aw-skill-eval spec validate` 为真值；本文件只说明稳定的信息放置和 Oracle 设计边界。

## Suite 级信息

selected cases 文档使用 `version`、`suite` 和非空 `cases`。suite 选择 `kind` 并保存：

- `unitUnderTest`：被评估 Skill。
- `defaultGrader`：suite 的默认 grader；provider 已有明确默认时仍要确认该选择是有意的。
- `policy`：optimization、false-negative/false-positive 成本和理由。
- `runtime`：该 suite 的 isolation、fixture 或其它 provider runtime 条件。

这些信息不复制到普通 case。

## 普通 case

所有 kind 都使用 `id`、`split` 和 `tags`。

- `trigger`：`input.query` 加一个 route 预期。单 Skill 布尔预期使用 `input.expectedLoad`；多 Skill route 使用 `input.expected.loadedSkills`。只在场景需要时增加 spawn 或 workspace fixture 输入。
- `conversation`：`prompt` 和非空、可观察的 `assertions`。只在需要时增加 scripted replies、workspace files、期望输出、允许的 workspace 变化或 artifacts。
- `custom-process`：按 provider 合同使用 JSON `input`、`expected` 或 `assertions`。它只用于可信、协作式 provider，不是 sandbox：provider 和后代保留 Engine marker、留在初始进程组、不 detach，且在最终 JSON 前退出。Engine 在运行期观察；违反或检查失效时 fail closed。不要发明第二份 provider schema，也不要在每个 case 重复 containment 检查。

普通 case 不要求重复 unit、provenance、scenario family、decision context 或完整 Oracle object。场景族可用 tags 或 suite 设计说明表达。

## 条件性 audit metadata

只有以下 tag 触发附加字段：

| Tag | 必要信息 |
| --- | --- |
| `boundary`、`regression` | `audit.rationale` 与 `audit.minimalCounterexample` |
| `release-critical`、`high-cost` | `audit.errorCost` |
| `high-variance` | `audit.allowedVariance` |

一个 case 有多个关键 tag 时合并要求。representative、challenge 和 diagnostic case 没有相应风险时，不增加空的 `audit` object。

## Oracle 与运行策略

Oracle 只声明可观察结果，并允许不影响决策的表述差异。先写最小反例，再决定是否需要 boundary case。三次运行只可作为初始取样；混合结果需要根据错误成本扩大样本或检查 trace。challenge/diagnostic 不自动进入发布指标。
