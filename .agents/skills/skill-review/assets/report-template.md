# Skill 评审报告

只保留当前模式需要的章节：quick 省略缺少证据的深入审计且不计算总分；delta 重点报告问题关闭且不计算总分；release 包含所有适用门禁和证据章节。

## 结论

- **Skill：**
- **模式：** quick | full | release | delta
- **方向：** aligned | at-risk | drifted
- **发布结论：** pass | pass-after-fixes | provisional | fail
- **加权总分：** 数字 | 不计算
- **质量带：** excellent | strong | adequate | weak | poor | 不计算
- **覆盖率：**
- **置信度：**
- **一句话结论：**

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | | known / unknown |
| 已观察失败 | | known / unknown |
| 成功标准 | | known / unknown |
| 目标环境或客户端 | | known / unknown |
| 范围外事项 | | known / unknown |
| 相邻 Skill | | known / unknown |
| 发布要求 | | known / unknown |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | | | | | |
| critical-artifacts | | | | | |
| goal-alignment | | | | | |
| capability-validity | | | | | |
| safety-permissions | | | | | |
| architecture-ownership | | | | | |
| release-evidence | | | | | |

## 优点

只列出有包内材料、normative 或 observed 证据支持的优点。

## 必须修复的问题

只列 P0/P1。

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 非阻断问题

叙述报告默认最多展开 5 项影响最大且可执行的 P2。所有与分数关联的 finding 都保留在结构化 scorecard 中。

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |

不要把证据缺失转换成 finding。所有与分数关联的 unknown 都保留在结构化 scorecard 中。

## 维度评分

quick 只包含已检查维度；full/release 包含全部 12 个维度；delta 只包含受影响维度。未评分不等于 0 分。

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 7 | | | | | | |
| 问题基础与实际价值 | 8 | | | | | | |
| 调用策略、触发条件与 Context Pointer | 12 | | | | | | |
| 范围、边界与组合性 | 8 | | | | | | |
| 程序、完成边界与控制校准 | 12 | | | | | | |
| 信息层级、上下文负载与渐进式披露 | 12 | | | | | | |
| 职责归属与自然语言状态机风险 | 10 | | | | | | |
| 脚本与确定性自动化 | 8 | | | | | | |
| 资源可达性、Co-location 与用途 | 5 | | | | | | |
| 评测、验证与证据驱动迭代 | 10 | | | | | | |
| 可靠性、安全与兼容性 | 4 | | | | | | |
| 剪枝、事实源与变更纪律 | 4 | | | | | | |

## 调用与 Context Pointer 审计

full/release 必做；quick 仅在触发是评审重点时使用。

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 是否重复同义 branch | 是否重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |

## 信息层级图

full/release 必做；渐进式披露存在争议时也使用。

| 内容 | 类型 | 适用 branch | 当前位置 | 是否每次需要 | 到达 pointer 或环境事实源 | 完成边界 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |

类型只能是：`in-file-step`、`in-file-reference`、`disclosed-reference`、`environment-lookup`。

## 完成边界审计

full/release 必做；步骤存在跳过、仓促完成或过度执行时也使用。

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |

## 架构与职责归属

- **Skill 负责的策略：**
- **Schema 或客户端负责的事实：**
- **Runtime 负责的状态：**
- **脚本候选：**
- **仅属于 role 的约束：**
- **仅属于 eval 或 issue 的问题：**
- **自然语言状态机风险：** low | medium | high

## 脚本与资源

- **已有脚本或正确省略：**
- **接口、依赖和安全质量：**
- **模型仍在重复的确定性逻辑：**
- **Reference 和 asset 可达性：**
- **重复：**
- **Scattering 与 co-location：**
- **不必要缓存的环境事实：**
- **过期或孤立资源：**

## 评测与证据

- **Trigger eval 与触发率：**
- **Behavior 或 regression eval：**
- **Runtime trace：**
- **基线：** no skill | minimal skill | previous version | none
- **Ablation 或 no-op 证据：**
- **Token、时间和方差成本：**
- **发布仍缺少的证据：**

## 差量与沉积

delta 模式必做；其它模式按需使用。

- **上一版 P0/P1 关闭情况：**
- **受影响维度：**
- **直接回归：**
- **SKILL.md、pointer、branch 和资源变化：**
- **行为指标变化：**
- **新增规则及其替代内容：**
- **沉积候选：**
- **净变化：** smaller | neutral | larger

## 最小改进路线

### 现在——发布阻断

1.

### 下一步——高价值质量改进

1.

### 以后——启发式、评测或产品/runtime 工作

1.

## 停止决定

说明为什么现在应停止评审，或指出再次迭代前必须出现的 observed、normative 或 structural 新证据。
