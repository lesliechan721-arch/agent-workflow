# Catalog 维护

维护 Workspace、插件组成、依赖、版本或删除 Plugin 时使用。先固定主入口确认的 Workspace，不从任意 cwd 推断另一个目标。

## Workspace 与组成

只在用户请求初始化时运行公开 `aw catalog init`，随后用静态 status 确认 marker、identity 和 inventory。现有 Workspace 直接读取当前 status 与 source metadata。

插件 source 使用 canonical `<root>/plugins/<name>`。维护 metadata、inventory 与 manifest dependency composition；依赖按实际可安装组合声明。Plugin 内部内容采用 Plugin 开发（`references/plugin-development.md`），共享文件与构建边采用 构建与共享（`references/build-and-sharing.md`），两类关系分别核对。

Plugin source version 与 Catalog version 分开。Catalog version 只通过公开 `aw catalog version` 管理，不手改生成 snapshot、digest 或内部状态。

## 删除 Plugin

删除改变 Catalog 组成。用户指定删除目标后，先从 status inventory 唯一定位 canonical plugin，读取 `aw plugin remove --help`，核对反向依赖和当前 Git 状态。

公开 remove 要求目标已经存在于 Git HEAD，且当前目标树的文件内容、可执行位和形状与 HEAD 相符。目标内已暂存、未暂存、未跟踪、ignored 内容、符号链接或额外节点等会影响该前提；以命令真实诊断为准。存在反向依赖时先解决有效依赖关系，不能强制绕过。

条件满足且删除在授权范围内时，用公开参数执行 remove。遇到保护性拒绝，报告具体阻碍及需要处理的来源；不改用 `rm -rf`、猜测 `--force`、改写 HEAD，或手动制造 tombstone/ledger。此任务不自动丢弃用户变更。

remove 不自动提升版本、提交、构建或发布。删除后重新取得 status，核对剩余 inventory 和依赖；只验证剩余受影响插件。inventory 为空时不对已删除或不存在的 Plugin 执行 validate/test/build，仍可按任务验证空 Catalog。

## 聚合与状态变更

修改组成后，按本次交付需要运行 Catalog build 和 complete validate，使用它们管理 snapshot。只读分析保持静态；未运行的聚合检查明确列为未验证。

用户明确要求把当前 Workspace 设为本地开发源时采用 Development source（`references/development-source.md`）。activate 自己负责 build、完整 validate、注册、sync 和 readiness，不在前后重复编排这些步骤。

交付实际 status、变更或删除回执、剩余依赖影响及验证范围。远端分发由用户显式启动 `publish-aw-catalog`，普通 Catalog 维护不自动发布。
