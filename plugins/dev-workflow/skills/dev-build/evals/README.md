# Fast、Build 与自适应 Review 评测

此目录保存评测资产，不进入 Skill 运行时。普通 trigger/conversation suite 已在各 Skill 的 manifest 中注册。角色上下文与 Ticket 交接 suite 使用 `context-role-workflow.mjs` 接入当前 codex-workflow Engine，先设为非发布阻断；原有 suite 的发布政策保持不变。

原草案的 52 条用例均保留：14 条 trigger/routing、20 条 conversation、18 条运行时草案。适配当前 decision-kit 后，另补充有界访谈和独立原型两条路由边界。完整用例分布在 dev-workflow、dev-build、dev-breakdown 和 dev-implement 的 evals 目录。

## 运行时草案

以下 18 条 Build/checkpoint/自适应修复用例尚无 prepare/grade adapter，不注册为可运行 suite：

- [实施协调](drafts/dev-build-workflow-cases.json)：8 条，覆盖真实 worker、依赖、集成、阶段审查与恢复。
- [Checkpoint 与历史](drafts/checkpoint-workflow-cases.json)：4 条，覆盖授权、完整基线和文件树一致性。
- [自适应修复](drafts/adaptive-review-workflow-cases.json)：6 条，覆盖真实续修、预算恢复、共享批次、专项审查和报告冲突。

接线方法见 [ADAPTER-PLAN.md](drafts/ADAPTER-PLAN.md)，行为判据见 [ADAPTIVE-REVIEW-CASES.md](drafts/ADAPTIVE-REVIEW-CASES.md)。接线必须复用当前 Engine；没有真实执行证据的项目保留 unknown/unavailable，不能用预置历史或最终自述证明通过。

## 持续对齐与执行闭环

新增八个 suite 保留原 manifest 的全部 suite、profile 和 release flag，新增项均为非发布阻断。它们包含 23 条 `codex-workflow` 和 8 条 conversation 用例。草案的双答案用例拆成两个独立运行，初始请求和文件相同；用户答案只存在于 Eval 输入和 Engine 响应器，不能进入被测者初始上下文。其余草案的请求、测试数据、断言和审计依据保留。

`workflow-evaluation.mjs` 接入持续对齐、milestone、Git 边界与 Spec 恢复场景。需要实际答复或产品行为检查的九条原 conversation 用例采用 workflow 外形；无隐藏答复的八条规格/角色用例保留 conversation，其中可写 Spec 用例补充当前 runner 必需的 `spec.md` 产物观察项，不增加语义断言。`continuous-alignment-workflow` 归属 `dev-workflow`，不是 `dev-build`；草案的 `setup.prototype` 在当前 JSON 安全合同中改名为 `setup.prototypeEvidence`，文字含义不变。

Engine 的可选 `evaluation` 负责真实问答、逐项独立语义核对和事件/产物证据。adapter 负责真实隔离 Git 基线、角色文件、产品断言和合并必要检查。现有角色/Ticket adapter 同样要求独立语义证据；关键词、工具调用参数、模型“已确认”标签或两个标题都不再足以通过。

`workflow-results.mjs` 的 Node Oracle 在实际产品上检查不同输入集合、答案对应结果、顺序与输入保持。视觉 Oracle 在两个指定视口实际操作页面并比较已接受关系，允许等价 DOM/CSS；它与被测 reviewer 的实际视觉审查是两份不同证据。Runtime 中必须能解析 `playwright` 并使用已安装浏览器；缺少此能力返回 `unknown`，不自动安装、不回退到工具痕迹。浏览器工具在独立 Node 子进程中运行，其依赖声明位于 `browser/package.json`，由 Eval 工具宿主提供，不进入插件安装依赖或被测产品。`packages/cli/tests/smoke/dev-workflow-eval-browser.test.ts` 使用本仓库已声明的 Playwright 和只读浏览器缓存，验证真实子进程、两视口和产品反例；这不证明未来 Eval 运行环境已具备该能力。

Manifest v1 要求 provider 依赖闭包位于该 Skill 的 Eval 根。Eval 工具闭包（五个模块与一个浏览器依赖声明）由本目录维护，通过 `node plugins/dev-workflow/scripts/sync-workflow-evals.mjs --write` 同步到 `dev-workflow/evals/runtime/`。默认或 `--check` 只核对相同内容；普通测试只检查，不写入。不得修改生成副本或用跨目录导入绕过 prepare 的路径边界。

这些 suite 需要包含可选 `WorkflowRequest.evaluation` 的 Engine。准备和确定性测试不调用模型；真实运行前仍须准备当前 Spec、取得精确绑定的独立 passing Audit，并披露语义 matcher 和最终 grader 的额外模型调用。所有调用共用 attempt deadline，usage 包含它们的消耗。恢复场景通过实际准备轮次取得任务；前提未建立、任务已失效或证据无法确认时保留未覆盖。

## 验证与比较

确定性检查验证结构、adapter prepare/grade、资源打包和夹具行为，不证明模型已正确路由、创建独立 reviewer、协调多个 worker 或恢复修复预算。真实模型运行需先按当前 AW 流程准备 EvalSpec，取得独立 passing EvalAudit，再由 Engine 执行。本次修复只进行静态审核和测试，不运行模型。

三轮是尚待行为与成本证据验证的默认上限。比较“一轮”与“三轮”时，两边必须都有相同 Build 能力，使用相同任务、授权、模型、工具和 Oracle；不能用尚无 dev-build 的旧仓库直接充当同能力对照。旧的一轮授权兼容测试仍按一轮判断。

先验证第二轮有新依据时续修、无新诊断时早停、耗尽不交付、默认预算不等于授权、incomplete 不盲改，以及当前完整结果 clean 后结束。后续接线再验证真实 worker/reviewer 与恢复。

比较实际缺陷关闭、直接回归、范围扩散、人工介入、正确早停、tokens、耗时和成本，不按 clean 次数或轮数优化。不要逐轮投喂预制 finding 来制造多轮收益；历史恢复用例不能代替从原始缺陷开始的全程比较。缺少净收益时重新评估默认上限。
