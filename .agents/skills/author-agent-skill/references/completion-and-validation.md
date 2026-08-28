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
