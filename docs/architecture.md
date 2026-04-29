# Architecture

## CLI Source Layout (`packages/cli/src`)

- **`commands/`** — 编排 `init`、`install`、`uninstall`、`upgrade`、`status` 五个命令；`options.ts` 统一归一化命令参数，`runtime.ts` 统一注入 env、native runner、prompt、reporter 和 debug logger，`discovery.ts` 枚举受管或可发现插件，`interactive.ts` 只在 CLI entry 层处理候选选择，`common.ts` 放平台推断、catalog/ledger 准备和共享状态格式化逻辑
- **`adapters/`** — `claude.ts` / `codex.ts` 处理平台原生状态与命令调用；`helpers.ts` 放共享 adapter 逻辑；`types.ts` 放 adapter 层私有类型
- **`generators/`** — `instructions.ts` / `permissions.ts` / `hooks.ts` / `agents.ts` 分别生成对应产物；`local-plugin.ts` 处理 repo-managed 文件生成；`shared.ts` 放跨生成器共享逻辑
- **`output/`** — `reporter.ts` 负责 stdout/stderr 的 notices、warnings 和 verbose 诊断渲染；`debug-log.ts` 负责调试日志落盘、轮转和失败提示；`redact.ts` 统一脱敏 token、password、authorization、cookie 等敏感字段
- **`utils/`** — `manifest.ts` 解析 plugin manifest；`marketplace.ts` / `local-marketplace.ts` 处理 marketplace 数据；`plugin-catalog.ts` 做 catalog 解析和 embedded/local 选择；`tracking.ts` 管理项目侧生成产物清单；`generated-artifacts.ts` 管理生成产物与回滚；`bundle-layout.ts` 校验 embedded bundle 一致性；`codex-config.ts` 做 Codex 配置 round-trip；`skill-trigger-preferences.ts` 处理安装时触发策略物化和 drift 检查；`paths.ts` / `detect.ts` / `file-rules.ts` 等放底层辅助
- **`constants.ts`** — 全局常量：`GENERATED_FILE_PREFIX = 'aw-'`、`TRACKING_MANIFEST_FILE = '.agent-workflows-manifest.json'`、`DEFAULT_CLAUDE_HOOKS_PATH`、`CLAUDE_MARKETPLACE_PATH`、`CODEX_MARKETPLACE_PATH`
- **`types.ts`** — 项目全局类型定义

## Three-Layer Distribution Model

```
Source layer（仓库内）
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**

          ↓ pnpm build（scripts/bundle-plugins.ts 打包）

Embedded Runtime Bundle（npm 包内）
  packages/cli/plugins-dist/
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/{.agents-plugin,.claude-plugin,.codex-plugin,...}

          ↓ pnpm publish:cli（先执行 `pnpm pack:cli` 验收，再按 `packages/cli/package.json` 的 `publishConfig.registry` 发布）

npm Registry
  @yiliang/aw

          ↓ aw init / 安装流程同步

本地 Marketplace 镜像
  ~/.aw/
  ├── config.json
  ├── installed.json
  └── plugins/<name>/**
```

三层各有职责，互不替代：

- 仓库源码层是插件作者维护的唯一输入，不手写平台 runtime manifest。
- `packages/cli/plugins-dist/` 是 `pnpm build` 产物，会随 npm 包发布，不手改。
- `~/.aw/` 是本机 marketplace 镜像和安装账本，`aw init`、`aw install`、`aw upgrade` 会按需同步。

排查问题时先确认问题发生在哪一层：源码 contract、bundle 生成、本机 runtime 镜像，还是平台配置。

## Key Paths

- `package.json` — repo root 统一入口，包含 `build`、`test`、`pack:cli`、`publish:cli`
- `packages/cli/scripts/bundle-plugins.ts` — build 时把源码插件打成 `plugins-dist`
- `packages/cli/plugins-dist/`、`packages/cli/dist/`、`packages/cli/coverage/` — 产物目录，不手改
- `plugins/git-commit/` — 真实样例插件，演示标准插件结构
- `.agents/skills/create-agent-workflows-plugin/` — 插件作者工具（含 `SKILL.md`、`agents/openai.yaml`、脚手架/校验脚本和 `references/` 下的作者参考文档）
- `docs/plugin-installation.md` — CLI 使用、scope/platform 行为和排障入口
- `docs/plugin-authoring.md` — 插件源码 manifest、hook、skill trigger 与 scope 语义入口

## Runtime State

- 执行型命令（`install`、`uninstall`、`upgrade`）默认使用 `scope=user`、`platform=auto`；`status` 的 `scope/platform` 是过滤条件，不在 CLI entry 层套用写入型默认值。
- Claude Code：通过 `claude plugin marketplace add` / `claude plugin install` 接入本地 marketplace；项目或用户 scope 的 rules/permissions 由 CLI 生成并用 `.agent-workflows-manifest.json` 追踪。
- Codex：需要原生 plugin 能力时先调用 `codex plugin marketplace add <canonical ~/.aw>` 注册 local marketplace，再由 AW 写入 `[plugins."<plugin>@aw"] enabled = true`；project scope 只影响当前仓库 `.codex/` 下的 repo-managed artifacts。Codex local source 注册不会产生 `.tmp/marketplaces/aw` 物化副本，status 也不应要求这个副本存在。
- 两个平台共享 `~/.aw/installed.json`。它记录 scope、平台、能力快照和 `skillTriggerPreference`，用于重复安装、升级、卸载和 status drift 判断。

## Command Runtime

CLI entry 和 direct command 共用 `CommandExecutionContext`。所有会影响外部世界的能力都从这里进入：`env`、adapter factory、native CLI runner、prompt、reporter、debug logger 和 diagnostics。新增 helper 时必须继续消费 context 里的 `env`，不能退回 `process.env`；测试也应该通过同一条 context 注入 fake runner、fake prompt 或 fake adapters。

交互式逻辑只存在于 `commands/interactive.ts` 和 CLI action 之间。底层 `installCommand`、`uninstallCommand`、`upgradeCommand` 仍按确定性 options 执行，便于脚本化调用和单元测试。交互式选择使用带身份的候选项，身份包含 plugin、platform、scope、projectKey 和 executionCwd，不能只按插件名模糊 dispatch。

## Output and Debug

命令结果逐步从散落的 `output` / `warnings` 迁到结构化 notices 和 events。默认 stdout 面向日常使用，说明目标插件、platform、scope、本地 marketplace、native 注册或插件启用结果，以及下一步命令；`--verbose` 把 options normalization、platform/catalog 选择、marketplace 修复判断和降噪后的 drift 诊断写到 stderr；`--debug` 或 `AW_DEBUG=1` 生成脱敏 debug log，并隐含 verbose。

debug log 记录 runId、argv、cwd、关键路径、native invocation、文件写入摘要、rollback/degraded 和最终错误，但不记录完整敏感内容。写命令默认写到 `~/.aw/logs`；`status` 默认写到系统临时目录，避免为了诊断破坏只读合同。`status --json` 独占 stdout，人类诊断、warning 和 debug log 路径只能进入 stderr 或日志文件。

## Discovery and Status

`commands/discovery.ts` 是 status、交互式 uninstall 和交互式 upgrade 的候选来源。它合并 AW ledger、project tracking manifest、Codex/Claude 原生配置、runtime evidence 和 current catalog；current catalog 找不到时会生成保守的 historical placeholder。

historical placeholder 必须按 platform + scope 分格。Codex 只有 ledger coarse boolean（例如 `hasRepoManagedArtifacts: true`）时，不能恢复成 hook、instruction、permission 或 agent 等具体能力；只有 tracking artifact kind、hook identity 等明确证据存在时，才能恢复对应能力。

`aw status` 是只读状态面板。它默认跨 platform/scope 扫描，输出“状态摘要 + 明细 + 下一步”；`--verbose` 展开诊断字段；`--json` 输出稳定 schema。status、discovery 和相关 adapter status 路径不能调用 `ensureLocalMarketplace()` 或修复 `~/.aw`，stale 或损坏的本地 marketplace 只能只读回退 embedded catalog，并在 verbose/json 里说明原因。
