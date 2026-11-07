# Testing Guidelines

> [!NOTE]
> 本文件已迁移至维护者规范目录。仓库通用测试政策、层级与门禁唯一权威正文见：
> [测试指南与 Test Value Gate](maintainers/testing.md)
> CI 矩阵与平台运行策略见 [CI 说明](maintainers/ci.md)。
> 具体插件的专属测试细节（如 Agent Subagent 的 Windows 分片与超时设置）见所属插件维护文档：
> [Agent Subagent 运行时验证](../plugins/agent-subagent/skills/spawn-subagent/docs/runtime.md#插件专属测试与-windows-原生验证边界)。

## Test Layers

完整层级说明见 [Test Layers](maintainers/testing.md#test-layers)。

### Coverage and Smoke Commands

烟雾测试与测试命令见 [Coverage and Smoke Commands](maintainers/testing.md#coverage-and-smoke-commands)。

## Fixture and Assertion Rules

合成环境隔离与真实断言规则见 [Fixture and Assertion Rules](maintainers/testing.md#fixture-and-assertion-rules)。

## Test Value Gate

测试准入门禁与静态合同例外见 [Test Value Gate](maintainers/testing.md#test-value-gate)。

## Validation Matrix

交付验证矩阵与各变更域检查见 [Validation Matrix](maintainers/testing.md#validation-matrix)；CI 矩阵与平台运行策略见 [CI 说明](maintainers/ci.md)。

## Build Reuse

构建缓存与复用策略见 [Build Reuse](maintainers/testing.md#build-reuse)。

## Performance Tests

性能预算与耗时测试见 [Performance Tests](maintainers/testing.md#performance-tests)。

## Test Isolation

环境隔离与进程树清理保证见 [Test Isolation](maintainers/testing.md#test-isolation)。

## Completion Check

完成判定与验证入口见 [Completion Check](maintainers/testing.md#completion-check)。
