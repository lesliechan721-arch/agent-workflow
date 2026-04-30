# `codex-explorer-plugin.md` 执行计划审查报告

审查对象：`docs/dev/plans/codex-explorer-plugin.md`
审查时间：2026-04-30

本轮审查范围：

- 基于当前仓库基线做执行计划 review，不是代码实现 review
- 同时检查方案自洽性、在当前基线下的可落地性，以及测试计划是否覆盖修改面

对照依据：

- 计划文档：`docs/dev/plans/codex-explorer-plugin.md`
- 当前约定：`docs/architecture.md`、`docs/plugin-installation.md`、`docs/testing.md`
- 当前实现：`packages/cli/src/**`、`packages/cli/tests/**`

## Findings

### 1. [高] 计划把 user scope role 绑定到 effective config，但 current baseline 的 effective config 含 project 层，这会让全局 user artifact 没有稳定真值

计划要求 config 写入后“重新解析 effective config，重渲染受管 Codex role artifact”，并且在 project scope 配置变化时，还考虑刷新当前会话下可定位的 user target，见 `docs/dev/plans/codex-explorer-plugin.md:327-340`。同时，风险部分把这件事解释成“当前上下文已刷新，历史 project 可能仍旧过期”，见 `docs/dev/plans/codex-explorer-plugin.md:548-550`。

但当前基线里，effective config 的定义是固定的 `manifest default < user store < project store`，project 会覆盖 user，见 `docs/plugin-installation.md:98-100` 和 `docs/architecture.md:66-69`。而 Codex user scope artifact 的物理位置又是全局 `~/.codex`，project scope artifact 才写入仓库 `.codex`，见 `packages/cli/src/utils/plugin-config.ts:112-123` 与 `packages/cli/src/utils/paths.ts:125-145`。

这两件事放在一起后，当前计划会出现一个没法靠“只刷新当前上下文”解决的矛盾：

- 同一个 user scope role file 只有一份，位置在全局 `~/.codex/agents/...`
- 但它如果按 effective config 渲染，就会在不同 repo 下看到不同的 project 覆盖值
- 结果是同一份全局 artifact 会被 repo A 和 repo B 轮流改写，`lastRenderedConfigDigest` 也不再有稳定语义

这不是单纯的“还有些历史项目没扫描到”，而是“同一个 user artifact 不存在唯一正确内容”。按当前计划推进，status 里的 stale 判断、config-triggered refresh 和 install 时的配置解释都会变得不确定。

建议先把 contract 收紧，再进入实现：

- 方案 A：明确 `scope=user` 的 Codex role 只吃 `default + user store`，不吃 project store；只有 `scope=project` 安装才读取 project 覆盖
- 方案 B：保留 effective config 语义，但把 `codex-explore` 限制为 project-scope repo-managed 插件，不支持 user scope role artifact
- 方案 C：如果一定要保留 user scope 安装，也必须把“artifact 绑定哪一层 config”定义成独立规则，而不是直接复用通用 effective config

在这点没定清之前，阶段 4 的 refresh contract 和阶段 3/4 的 status digest 真值都还不能算落地。

### 2. [中] 测试计划没有覆盖到全部修改面，尤其缺少 refresh 写命令全路径、upgrade、authoring tools 和 status JSON contract

计划正文里要改的不只是 install/uninstall/status。它还明确要求：

- 给四个 `aw config` 写命令都接入 refresh，且失败时要回滚并写 refresh metadata，见 `docs/dev/plans/codex-explorer-plugin.md:320-344`
- 更新作者工具 reference 和校验脚本，见 `docs/dev/plans/codex-explorer-plugin.md:414-423`
- 让 tracking / status / uninstall / upgrade / refresh 都按 `roleKey` 工作，见 `docs/dev/plans/codex-explorer-plugin.md:554-566`

但测试计划本身只显式列了：

- install / uninstall / status 的集成覆盖
- 一个 `aw config set` 的正向 refresh 场景
- 一个 unrelated key 不刷新场景
- build / pack smoke

见 `docs/dev/plans/codex-explorer-plugin.md:424-478`。

这和仓库现有测试约定不一致。当前测试文档已经把这些面单独列成重点：

- `upgrade-command.test.ts`、`skill-trigger-command.test.ts`、`authoring-tools.test.ts` 都是既有重点入口，见 `docs/testing.md:13-19`
- status 改动需要锁住默认/verbose/JSON/debug 通道以及稳定机器字段，见 `docs/testing.md:39-47`
- 改 plugin manifest contract、本地 marketplace 布局或作者工具时，需要同步 fixture、样例和相关测试，见 `docs/testing.md:59-64`

按这个标准，当前计划至少还缺这些明确测试项：

- `aw config configure/unset/reset` 命中 refresh key 的行为，而不只是 `config set`
- refresh 失败后的 config store / artifact 回滚，以及 `lastArtifactRefresh.status = "failed"` 的 status 诊断
- `aw upgrade codex-explore` 在普通升级和 capabilityChanged/重装路径下都继续按 `roleKey` 处理 artifact
- `status --json`、`status --json --verbose` 等输出仍保持纯 JSON，并暴露新增 role 诊断字段
- `authoring-tools.test.ts` 或等价用例，覆盖 `codexRole`、Codex-only 插件、`agents/openai.yaml` 必填和校验报错
- source manifest / bundle layout 的约束测试，确认 `codexRole` 保留在 `.agents-plugin/plugin.json`，但不会漏进平台原生 manifest

这一项不一定阻塞方案方向，但如果不补进计划，实际实现很容易出现“功能做了、回归网没跟上”的情况。

## 结论

这份执行计划的主方向仍然是对的：它确实沿着现有 `manifest -> generator -> adapter -> tracking -> status -> config` 主链路扩展，没有绕开当前架构另起一套。

但当前还有 1 个需要先收口的阻塞点：user scope role artifact 到底绑定哪一层配置真值。这个问题不先定清，后面的 refresh、digest stale 和 status 解释都会变成不稳定语义。

除此之外，测试计划也还不够完整。建议在进入实现前，先把 config refresh 四个写命令、upgrade、authoring tools、status JSON 和 source-manifest contract 的测试补进计划，这样实现拆分时才不会漏掉关键回归面。
