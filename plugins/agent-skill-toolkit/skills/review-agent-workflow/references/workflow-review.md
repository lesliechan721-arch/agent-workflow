# Workflow Review

## 六个组合维度

### 1. Entry and routing

检查入口 owner、触发竞争、循环路由、无 owner 请求，以及 leaf Skill 是否被迫承担顶层路由。

### 2. Responsibility boundaries

检查每个组件是否拥有连贯职责；Author、Reviewer、Eval Designer、Auditor、Runner、发布与项目适配是否混合；通用能力是否反向依赖项目实现。

### 3. Handoffs and context

检查每条边是否真的需要 handoff；传递的是昂贵证据还是可便宜重算的事实；是否为了上下文隔离制造持久状态；子代理输出是否足以让父级判断。

### 4. State and evidence ownership

检查 identity、digest、readiness、coverage、Audit 和运行证据是否只有一个权威 owner；同一状态是否在 prose、JSON、summary 和 gate 中重复编码；模型是否填写机器可直接计算的事实。

### 5. Permissions, cost and failure propagation

检查只读、写入、高成本执行和发布是否混合；局部失败是否正确阻断；optional branch 是否进入 common path；失败是否被其它成功结果掩盖；是否存在隐式授权。

### 6. Minimum architecture and change containment

写出同样安全的更短路径；逐个说明 handoff、schema、stage 和 validator 防止的现实失败及删除后的最小替代；评估 leaf 修改对其它消费者的影响。

## Leaf Fix Admission

建议修改 leaf Skill 前必须回答：

1. 根因是否在 leaf 的输入、输出、触发或职责内部？
2. 该 leaf 的直接调用者和已知其它消费者是谁？
3. 修改会改变哪些公共行为、权限、完成条件或输出合同？
4. 是否存在更正确的 workflow、adapter、router、handoff 或 runtime 修复？

未通过时，把 owner 归为 workflow、adapter、caller 或 runtime，不给 leaf `SKILL.md` 增加全局规则。
