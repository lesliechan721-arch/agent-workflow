# AW 方法用例

[method-cases.json](method-cases.json) 使用当前 Conversation Selected Cases v1。七个场景分别检查 source 分析、共享资源、静态平台差异、动态 target 的安装态配置、静态 Skill 的配置边界、安全删除与可比较运行包。

| 场景 | 真实前提与可检查结果 |
| --- | --- |
| `source_only_scope` | 有效 source Workspace；允许只读文件命令，不执行插件代码、构建或安装 |
| `shared_resource_authoring` | provider 真实脚本、consumer Native 与 Portable 声明；允许范围内修改 export/import 声明并核对能力传播 |
| `platform_choice` | 有效静态 Skill；选择足够的静态投影与实际 surface 验证范围 |
| `installed_config_choice` | 已声明的 Codex/user 动态 target、renderer、非敏感配置与 refresh key；修改 target 和脚本，不宣称未执行的真实安装验证 |
| `static_skill_config_choice` | 静态 Skill 及配置；说明受支持的动态 target 路径和未采用时的限制 |
| `catalog_remove_empty` | 从完整种子复制独立 Workspace，建立本地 fixture HEAD，再用公开 remove；最终 status 的 plugins 为空 |
| `comparable_finals` | setup 脚本建立真实 Git HEAD 后增加 dirty/untracked 输入；完整复制两版本，以同一 profile 准备各自 final 和 binding |

所有 `workspace_valid` 用例由 `scripts/method-fixtures.test.mjs` materialize 后通过公开 `aw catalog status --json` 与逐插件 `aw plugin validate --json` 检查；snapshot 的预期为 absent。测试还实际执行隔离 remove，验证空 Catalog，以及运行 comparison setup，证明 dirty/untracked 前提和缺少未跟踪输入时的物化拒绝。fixture 中的 Git 操作只在测试临时目录执行，不访问远端。

`comparable_finals` 使用 `simplify-fixtures/bin` 的明确测试替身。它检查真实复制输入、精确输出路径和 Codex/project 选择；缺少额外 untracked 输入时拒绝。该替身不证明生产 renderer、正式 source binding、Audit 或模型收益。其余场景使用实际公开作者命令；只读 case 的执行限制仍由 prompt 和轨迹检查约束。

每个可写 case 明确列出 `allowedWorkspaceChanges` 与实际 artifact；只读 case 不授权写入。模型执行、独立 Oracle 审核与真实 Native qualification 均为 NOT_RUN。确定性 fixture 检查只证明输入可达和已检查的机械行为。
