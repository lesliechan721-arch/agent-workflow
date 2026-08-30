# 完成与验证

完整创建或重大变更完成前检查：

- 目标问题、成功标准、scope 与 out-of-scope 仍一致；
- description 与实际调用方式一致；
- 主文件和 references 的 branch pointer 可达；
- scripts 有非交互接口、退出码、安全默认值和最小样例；
- assets 不隐藏强制指令；
- 没有把 schema 或环境事实复制成易漂移 prose；
- 修改范围内的确定性验证已经通过；
- 未执行的模型 Eval、独立 Review 或发布检查明确标为未验证。

作者完成条件是“请求的内容已修改并通过修改范围内的确定性验证”，不是“独立 Review 或 Eval 已通过”。

Eval 和独立 Review 不属于默认完成条件。用户另外明确要求执行已有 Eval 时，交给兼容 Runner；不先创建 Reviewer gate。Runner 从 suite/profile/case 选择准备并验证 `EvalSpec v1`，复用已精确绑定的单份 `EvalAudit v1` 或在全新上下文取得一份 Audit，获得本次副作用授权，执行 `aw-skill-eval run <spec> --audit <audit>`，再验证生成的 `EvalResult v1`。Audit fail 只停止 Eval 分支，不触发 Author 修改生产 Skill。clean success 不要求 triage；只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才在全新上下文做 result-triage。triage 默认在聊天中返回，用户指定时可写 `triage.md`，且不是 Release Check 的机器输入。
