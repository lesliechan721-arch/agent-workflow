# `plugin-extension-boundary-repair` 实现复审报告

审查对象：当前 `main` 分支实现（本轮复核覆盖 `0361a3a`、`dd0f0bf`、`0fb4e23` 三次修复）  
审查时间：`2026-04-27`

本轮复审对照了：

- 计划文档：`docs/dev/plans/plugin-extension-boundary-repair.md`
- 参考文档：`.agents/skills/create-agent-workflows-plugin/references/extensions-spec.md`、`references/mcp-and-apps.md`、`docs/plugin-installation.md`、`docs/coding-conventions.md`
- 实现代码：`packages/cli/src/**`、`.agents/skills/create-agent-workflows-plugin/**`
- 测试：`packages/cli/tests/**`

已执行验证：

- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm build`
- `pnpm test:smoke:build`

以上命令当前都能通过。

## Findings

本轮未发现新的实现问题。

上一轮报告遗留的 rendered hooks 事件名校验缺口已经补齐：

- `packages/cli/src/utils/rendered-contract.ts` 现在按平台限制允许的原生事件集合
- `packages/cli/src/utils/bundle-layout.ts` 继续复用共享 validator 校验 Claude bundle hooks
- `packages/cli/src/adapters/codex.ts` 在 install / uninstall / status 相关链路复用同一套 Codex hooks 校验
- `packages/cli/tests/unit/rendered-contract.test.ts`、`packages/cli/tests/unit/marketplace.test.ts`、`packages/cli/tests/unit/codex-adapter.test.ts` 已补上 `sessionStop` / `SessionEnd` 这类非法事件名负例

基于这轮代码复核和命令验证，上一版报告里的问题已经全部关闭，本轮也没有再发现新的中高严重度缺口。

## 分项结论

### 1. 实现代码质量

实现质量达到可接受上线标准，几个关键边界已经收口到清晰的共享入口：

- 公共 source contract 收口在 `packages/cli/src/utils/manifest.ts`
- rendered contract 收口在 `packages/cli/src/utils/rendered-contract.ts`
- 平台差异通过 `packages/cli/src/utils/platform-entries.ts` 和两端 adapter / generator 处理，没有重新散回命令层
- bundle 校验、install preflight、status drift 检测复用了同一套 contract，而不是各自维护分叉逻辑

代码结构上，这轮修复不是“局部打补丁”，而是把 source、bundle、install、status、authoring 几条主链路一起对齐了，整体一致性比上一轮明显更好。

### 2. 是否严格按照文档实现

本轮复核结论是“基本严格对齐”：

- permissions 公共语法已经按文档限制为普通 token 前缀，生成目标分别落到 Claude `Bash(...)` 和 Codex `prefix_rule(...)`
- hooks 公共事件集合已经收口为 `before_tool` / `after_tool` / `session_start` / `session_stop`，并分别映射到 Claude `SessionEnd` 与 Codex `Stop`
- `.mcp.json` / `.app.json` 已按 source / rendered 两层规则实现；source 层只要求顶层对象形状，rendered 层继续校验最终 artifact 语义
- `agentOverrides` 已进入 install、status、historical fallback 等平台生效视图，不再只在 bundle 阶段生效
- `init_plugin.js --with-apps` 已改为生成带示例 connector id 的最小 `.app.json`，与文档约定一致

我没有再发现“文档已经更新，但代码仍沿用旧 contract”的残留点。

### 3. 测试用例是否完全覆盖

以这轮改动范围来看，测试覆盖已经闭合，关键风险面都有对应断言：

- source 校验：`packages/cli/tests/unit/manifest.test.ts`
- generator 与平台映射：`packages/cli/tests/unit/generators.test.ts`
- rendered contract 与 bundle 语义：`packages/cli/tests/unit/rendered-contract.test.ts`、`packages/cli/tests/unit/marketplace.test.ts`
- Codex 安装 / 卸载 / drift / hooks 内容核对：`packages/cli/tests/unit/codex-adapter.test.ts`
- historical fallback 与 capability/status 视图：`packages/cli/tests/unit/adapter-status.test.ts`
- authoring 工具与脚手架：`packages/cli/tests/integration/authoring-tools.test.ts`
- 编译产物与 embedded bundle 健康检查：`packages/cli/tests/smoke/build-smoke.test.ts`

这不代表未来所有改动都天然无风险，但就本次修复目标来看，我没有再看到明显未覆盖的高风险分支。

### 4. 报告发现的问题是否修复并且没有其他未知问题

上一轮报告中的问题已确认修复：

- permissions 公共 parser 已拒绝 `*`、引号、转义和 shell 控制符
- source manifest 与 bundle manifest 的读取边界已经分层
- `.mcp.json` / `.app.json` 的 source / rendered 校验已经补齐
- Claude / Codex install 链路已经接入共享 rendered validator
- rendered hooks 非法原生事件名现在会在 validator、bundle 校验和 Codex hooks 链路中一致失败

“没有其他未知问题”这件事无法做绝对证明；但在本轮人工 review、现有测试矩阵和四组验证命令范围内，我没有再发现新的已知问题，也没有看到新的高风险漂移迹象。

## 复审结论

这次实现复审可以通过。

从代码质量、文档一致性、测试覆盖和问题关闭情况来看，`plugin-extension-boundary-repair` 这轮修复已经收口完成。上一轮报告中的问题已经全部修复，本轮未发现新的 findings；在当前审查范围内，可以认为实现已经满足计划要求。
