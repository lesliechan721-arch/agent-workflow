# 独立交付 Eval

来自 R1 独立交付设计。20 条 trigger 和 21 条 conversation 用例分别放在十个 Skill 自己的 `evals/independent-delivery-*-cases.json`，由同名 suite 注册。它们尚未取得独立 Oracle 审核或模型运行结果。

项目适配另在 `dev-workflow` 的 behavior suite 补充 Spec Review 尚有实质问题和必要证据缺口时的批准边界。新用例使用公开结果和工作区差异判断，不要求固定报告标题或 `clean / blocked / incomplete` 字词。旧报告仍是合法的恢复输入。历史 case ID 保持稳定，包括名字中仍含 `one-reviewer` 的原用例；其当前判据已改为默认双轴独立审查。

官方 trigger parser 要求小写 snake_case，因此 R1 的二十个新增 trigger ID 将连字符转换为下划线，例如 `dev-spec-positive` 对应 `dev_spec_positive`。用例输入与判据不变，conversation 和 runtime ID 沿用交付包名称；仓库原有 ID 均未改名。

Conversation provider 要求写入场景至少声明一个实际文件产物。七条原本只列允许路径的场景已补 `artifacts` 存在检查；两个 Ticket 场景在请求中明确下一批首项写入 `T1.md`，其余命名和任务粒度仍可选择。这些检查证明真实产物存在，内容质量仍由语义判据判断。

## Runtime 草案

以下九条保留为未注册草案；没有实现 adapter，也没有真实执行结果：

| 被测能力 | 草案 | 场景数 |
| --- | --- | ---: |
| dev-review-code | [代码审查](runtime-drafts/dev-review-code.workflow.json) | 2 |
| dev-build | [实施与恢复](runtime-drafts/dev-build.workflow.json) | 2 |
| dev-workflow | [任务位置、确认与连续交接](runtime-drafts/dev-workflow.workflow.json) | 5 |

[接线计划](runtime-drafts/ADAPTER-PLAN.md) 保存场景前提与当前 Engine 缺口。`fixtures/` 保存独立合成的页面与标签工作项，`fixture-solutions/` 只供验证者使用，不能注入 worker 的输入。runtime JSON 中已内嵌的工作资料继续保留；新 adapter 不得用参考实现替换本轮生成的 Spec、Ticket 或页面。

## 验证边界

官方 prepare 和 Spec validation 只证明注册、输入与物化合同。普通 conversation 不能仅凭回复中提到 reviewer 就证明存在独立上下文；真实委派和读取范围须由 runtime 证据验证。浏览器夹具通过也不证明模型能发现设计偏离。

后续先接当前单次 root 执行可覆盖的独立 worker 与设计对照，再补多轮确认、主上下文重建和故障注入所需能力。用例、Oracle 或 provider 输入变化后重新审核；未取得实际证据前保持未验证状态。
