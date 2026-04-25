# Architecture

## CLI Source Layout（`packages/cli/src`）

- **`commands/`** — 编排 `init`、`install`、`uninstall`、`upgrade`、`status` 五个命令；`common.ts` 放共享逻辑
- **`adapters/`** — `claude.ts` / `codex.ts` 处理平台原生状态与命令调用；`helpers.ts` 放共享 adapter 逻辑；`types.ts` 放 adapter 层私有类型
- **`generators/`** — `instructions.ts` / `permissions.ts` / `hooks.ts` / `agents.ts` 分别生成对应产物；`local-plugin.ts` 处理 repo-managed 文件生成；`shared.ts` 放跨生成器共享逻辑
- **`utils/`** — `manifest.ts` 解析 plugin manifest；`marketplace.ts` / `local-marketplace.ts` 处理 marketplace 数据；`plugin-catalog.ts` 做 catalog 兼容性判定；`tracking.ts` 管理 CLI 账本；`generated-artifacts.ts` 管理生成产物与回滚；`bundle-layout.ts` 校验 embedded bundle 一致性；`codex-config.ts` 做 Codex 配置 round-trip；`paths.ts` / `detect.ts` / `file-rules.ts` 等底层辅助
- **`constants.ts`** — 全局常量：`GENERATED_FILE_PREFIX = 'aw-'`、`TRACKING_MANIFEST_FILE = '.agent-workflows-manifest.json'`、`DEFAULT_CLAUDE_HOOKS_PATH`、`CLAUDE_MARKETPLACE_PATH`、`CODEX_MARKETPLACE_PATH`
- **`types.ts`** — 项目全局类型定义

## Three-Layer Distribution Model

```
源码层（仓库内）
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**

          ↓ pnpm build（scripts/bundle-plugins.ts 打包）

Embedded Runtime Bundle（npm 包内）
  packages/cli/plugins-dist/          ← 唯一运行时真值，不手改

          ↓ aw init / 安装流程同步

本地 Marketplace 镜像
  ~/.aw/                              ← 含 installed.json ledger
```

三层各有职责，互不替代；排查问题时先确认问题在哪一层。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts` — build 时把源码插件打成 `plugins-dist`
- `packages/cli/plugins-dist/`、`packages/cli/dist/`、`packages/cli/coverage/` — 产物目录，不手改
- `plugins/git-commit/` — 真实样例插件，演示标准插件结构
- `.agents/skills/create-agent-workflows-plugin/` — 插件作者工具（含 `SKILL.md`、`agents/openai.yaml` 及 `references/` 下的三份约定文档）
- `docs/dev/plans/npm-plugin-marketplace-new.md` — 当前分发方案权威文档；`npm-plugin-marketplace.md` 已标记历史文档
