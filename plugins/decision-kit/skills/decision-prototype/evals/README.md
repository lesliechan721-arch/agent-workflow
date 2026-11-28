# Decision Prototype 作者期评测

本目录由 `decision-prototype` 持有。按 manifest 的 suite/profile 单独准备，例如：

```bash
aw dev eval prepare decision-kit decision-prototype --suite builder-workflow --profile project-default --output /tmp/aw-eval-specs/decision-prototype-builder --json
```

仅执行 prepare 不启动模型。实际模型 Eval 需要独立 Audit 和执行授权，按 [Review 取证与 Eval 评估合同](../../../../../docs/reference/review-and-eval.md) 操作。

- `trigger`、`router` 和 `independent-delivery-trigger` 区分需要体验未定候选的产品决定、单纯内部工程实验和理解已有材料。
- `behavior`、`prototype-method`、`feedback`、`review-lifecycle`、`opening-policy` 及 `independent-delivery-behavior` 检查原型证据、反馈与版本绑定、打开/等待策略以及独立交付。
- `builder-workflow` 检查明确委派、普通页面的默认委派、子代理执行技术探针，以及无需委派的聊天示例和极小静态产物。`context-role-behavior` 检查已受派构建者直接执行并向当前协调者交接。

Builder 是本次委派职责，不是预注入的原生角色。Workflow adapter 不创建宿主 Agent 配置，也不注册固定角色名；Oracle 依据真实子线程创建、终态、文件写入归属、执行与主线程回读证据判定，而不是角色名字。Engine 未清理完成的记录不能形成这项 Skill 的行为评分。Review Shell 和实际会话生命周期另由插件的确定性测试与浏览器 smoke 覆盖。
