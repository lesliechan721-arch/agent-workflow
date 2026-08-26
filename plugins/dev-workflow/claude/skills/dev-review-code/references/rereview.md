# Code 复审

仅在已有上一份正式 Code Review，或用户明确要求复审时读取。

1. 当前完整实现和当前 Spec 是审查目标；上一份报告只作为比较证据。
2. 按当前保障等级创建新的 fresh reviewer，重新覆盖 Spec fidelity 与 Engineering quality。
3. 报告按需增加“与上一份 Review 比较”，列出已解决、仍存在和新发现的 blocker。
4. 新 finding 必须来自当前完整目标的证据，并达到初次 Review 相同的阻塞门槛：对交付有材料影响，且有可验证关闭条件。仅因 reviewer 偏好变化、发现更优方案或存在更简洁写法，不构成 blocker。
5. 复审为 `clean` 时可以交付；仍为 `blocked` 或 `incomplete` 时返回当前 finding，并停止本次 Review。

不要维护轮次计数或进展状态。是否继续下一次修复由调用者或用户决定。
