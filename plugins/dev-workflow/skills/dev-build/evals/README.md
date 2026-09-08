# Fast、Build 与自适应 Review 评测

此目录保存评测资产，不进入 Skill 运行时。普通 trigger/conversation suite 已在各 Skill 的 manifest 中注册；新增 suite 先设为非发布阻断，原有 suite 的发布政策保持不变。

原草案的 52 条用例均保留：14 条 trigger/routing、20 条 conversation、18 条运行时草案。适配当前 ask-me 后，另补充有界访谈和独立原型两条路由边界。完整用例分布在 dev-workflow、dev-build、dev-breakdown 和 dev-implement 的 evals 目录。

## 运行时草案

以下 18 条用例尚无 prepare/grade adapter，不注册为可运行 suite：

- [实施协调](drafts/dev-build-workflow-cases.json)：8 条，覆盖真实 worker、依赖、集成、阶段审查与恢复。
- [Checkpoint 与历史](drafts/checkpoint-workflow-cases.json)：4 条，覆盖授权、完整基线和文件树一致性。
- [自适应修复](drafts/adaptive-review-workflow-cases.json)：6 条，覆盖真实续修、预算恢复、共享批次、专项审查和报告冲突。

接线方法见 [ADAPTER-PLAN.md](drafts/ADAPTER-PLAN.md)，行为判据见 [ADAPTIVE-REVIEW-CASES.md](drafts/ADAPTIVE-REVIEW-CASES.md)。接线必须复用当前 Engine；没有真实执行证据的项目保留 unknown/unavailable，不能用预置历史或最终自述证明通过。

## 验证与比较

确定性检查验证结构、资源打包和夹具行为，不证明模型已正确路由、创建独立 reviewer、协调多个 worker 或恢复修复预算。真实模型运行需先按当前 AW 流程准备 EvalSpec，取得独立 passing EvalAudit，再由 Engine 执行。本次源码适配不包含模型运行。

三轮是尚待行为与成本证据验证的默认上限。比较“一轮”与“三轮”时，两边必须都有相同 Build 能力，使用相同任务、授权、模型、工具和 Oracle；不能用尚无 dev-build 的旧仓库直接充当同能力对照。旧的一轮授权兼容测试仍按一轮判断。

先验证第二轮有新依据时续修、无新诊断时早停、耗尽不交付、默认预算不等于授权、incomplete 不盲改，以及当前完整结果 clean 后结束。后续接线再验证真实 worker/reviewer 与恢复。

比较实际缺陷关闭、直接回归、范围扩散、人工介入、正确早停、tokens、耗时和成本，不按 clean 次数或轮数优化。不要逐轮投喂预制 finding 来制造多轮收益；历史恢复用例不能代替从原始缺陷开始的全程比较。缺少净收益时重新评估默认上限。
