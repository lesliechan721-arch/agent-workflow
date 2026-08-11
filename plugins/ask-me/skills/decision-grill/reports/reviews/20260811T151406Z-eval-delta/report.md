# ask-me Eval 差量审查

## 结论

- Skill：`decision-grill`（ask-me eval owner）
- 模式：delta
- 方向：aligned
- 差量审查结论：pass
- 加权分：91.2 / 100（coverage 56%，confidence low）
- 范围：eval 基础设施、合同、fixture、报告、测试和文档
- 范围外：Skill 文案、触发条件、真实模型路由质量和访谈质量

独立上下文审查最初发现 3 个阻塞问题。修复和复核后，3 个问题均已关闭，当前没有阻塞 finding。这个 `pass` 只适用于本次差量审查。完整模型发布矩阵尚未运行，因此插件的 release-evidence 门禁仍未关闭。

## 评审合同

| 项目 | 结论 |
| --- | --- |
| 目标问题 | 让单 Skill 与多 Skill eval 正确区分加载、等待、委派和最终答复 |
| 已观察失败 | exact-route 提前结束；strict 空 route 非零容忍；commentary 混入 finalMessages |
| 成功标准 | 不产生假通过或假失败；旧 `should_load_skill` 合同保持兼容；常见路径有回归测试 |
| 环境 | 当前仓库中央 Codex eval driver；Codex 模型行为，Codex/Claude 确定性插件合同 |
| 范围外 | Skill 触发文案与模型输出质量 |
| 相邻 Skill | `requirements-clarifier` 仅作为 participant；本次不判断其路由质量 |
| 发布要求 | 本次只关闭代码审查阻塞项；完整模型矩阵仍是独立门禁 |

## 门禁

| 门禁 | 状态 | 依据 |
| --- | --- | --- |
| package-validity | pass | validator 与插件合同测试通过 |
| critical-artifacts | pass | manifest、participant、corpus、fixture 均可解析 |
| goal-alignment | not_applicable | 用户明确排除触发与 Skill 行为评价 |
| capability-validity | pass | runtime 事件与工具能力有实现和测试 |
| safety-permissions | pass | strict 隔离和 workspace 保护合同保持有效 |
| architecture-ownership | pass | 生命周期与报告分类由中央 driver 管理 |
| release-evidence | unknown | 未运行完整 8-case × 10-run 模型发布矩阵 |

## 已关闭问题

| 原严重性 | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| P1 | exact-route 在委派前提前结束 | route 与 `should_spawn_agent` 联合决定 early stop | “读取 Skill → spawn”正反两条 app-server 测试 |
| P2 阻塞 | strict 空 route 允许一次误加载 | `expected_loaded_skills: []` 在 strict split 要求 100% 精确匹配 | 3 次中 1 次误加载必须失败 |
| P2 阻塞 | commentary 被计入 `finalMessages` | 只收集 `phase: final_answer` | finalMessages 排除 commentary，eventTrace 继续保留 |

## 差量与复杂度

- 修复只修改中央 driver 的局部判定和对应测试。
- 没有增加 Skill 文案或触发排除词。
- 没有为罕见竞态增加新状态或重试机制。
- 旧 `should_load_skill` 路径和非 strict route 阈值保持不变。
- 净变化：neutral。代码增加来自必要的报告字段、精确路由合同和回归覆盖。

## 验证

- `pnpm build`：通过。
- `pnpm test:unit`：67 个文件，881 个测试通过。
- `pnpm test:integration`：9 个文件，104 个测试通过。
- `pnpm plugin:test ask-me`：Codex 和 Claude 均通过。
- `validate_plugin.mjs plugins/ask-me`：通过。
- 独立复核：无阻塞问题。

## 未知项

- 完整双 Skill 发布矩阵未运行。
- 本次不评价 description 修改是否改善真实触发率。
- 本次不评价 with Skill 相对 baseline 的访谈质量增益。

## Stop decision

停止继续修改 eval 代码。现有 observed 和 structural 阻塞项已经关闭，相关常见路径有回归测试。下一步只有在完整模型矩阵产生新的可复现证据时，才继续调整路由或 Skill 文案。
