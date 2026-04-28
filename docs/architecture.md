# Architecture

## CLI Source Layout (`packages/cli/src`)

- **`commands/`** — 编排 `init`、`install`、`uninstall`、`upgrade`、`status` 五个命令；`common.ts` 放平台推断、catalog/ledger 准备、安装参数解析和 status 格式化等共享逻辑
- **`adapters/`** — `claude.ts` / `codex.ts` 处理平台原生状态与命令调用；`helpers.ts` 放共享 adapter 逻辑；`types.ts` 放 adapter 层私有类型
- **`generators/`** — `instructions.ts` / `permissions.ts` / `hooks.ts` / `agents.ts` 分别生成对应产物；`local-plugin.ts` 处理 repo-managed 文件生成；`shared.ts` 放跨生成器共享逻辑
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

- `packages/cli/scripts/bundle-plugins.ts` — build 时把源码插件打成 `plugins-dist`
- `packages/cli/plugins-dist/`、`packages/cli/dist/`、`packages/cli/coverage/` — 产物目录，不手改
- `plugins/git-commit/` — 真实样例插件，演示标准插件结构
- `.agents/skills/create-agent-workflows-plugin/` — 插件作者工具（含 `SKILL.md`、`agents/openai.yaml`、脚手架/校验脚本和 `references/` 下的作者参考文档）
- `docs/plugin-installation.md` — CLI 使用、scope/platform 行为和排障入口
- `docs/plugin-authoring.md` — 插件源码 manifest、hook、skill trigger 与 scope 语义入口

## Runtime State

- Claude Code：通过 `claude plugin marketplace add` / `claude plugin install` 接入本地 marketplace；项目或用户 scope 的 rules/permissions 由 CLI 生成并用 `.agent-workflows-manifest.json` 追踪。
- Codex：原生 marketplace/plugin 注册仍写入 user scope 的 `~/.codex/config.toml`；project scope 只影响当前仓库 `.codex/` 下的 repo-managed artifacts。
- 两个平台共享 `~/.aw/installed.json`。它记录 scope、平台、能力快照和 `skillTriggerPreference`，用于重复安装、升级、卸载和 status drift 判断。
