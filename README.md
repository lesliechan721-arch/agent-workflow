# Agent Workflows

Agent Workflows 是一个面向 Codex 和 Claude Code 的插件工作流仓库。这里维护插件源码、作者工具和发布为 `@yiliang/aw` 的 CLI；插件通过 `@yiliang/aw-plugins-manifest` sidecar 包和 `@yiliang/aw-plugins` full catalog 包分发。CLI 解析当前 catalog，把插件按平台和 scope 安装到 Codex / Claude Code 对应位置。

## 快速使用

```bash
npm install -g @yiliang/aw
aw init
aw install git-commit -p both
aw status
```

直接运行 `aw` 会进入交互控制台，从同一个入口完成安装、升级、配置、卸载、修复、清理、重新应用配置和状态排查。`install`、`uninstall`、`upgrade`、`config`、`status`、`repair`、`cleanup`、`reinstall` 这些子命令保留给脚本化调用；非 TTY 或 CI 环境下直接运行 `aw` 会确定性失败，并提示可复制命令和 `--json` 输出入口。

```bash
aw
```

脚本化写命令默认输出只展示用户能理解的完成结果和下一步；需要机器合同时加 `--json`，stdout 会是单一 JSON receipt。`--verbose` 展开诊断到 stderr，`--debug` 生成脱敏 debug log 并隐含 verbose。`aw status` 默认使用友好状态摘要，`aw status --verbose` 展开详细只读排查；`aw status --json` 输出 `statusSchemaVersion: 2`、`consoleItemsSchemaVersion: 3`、`friendlySummaries` 和 `consoleItems`。

`install`、`uninstall`、`upgrade` 默认写入 user scope；需要项目级产物时再显式传 `-s project`。Codex project scope 不会启用用户级 native plugin，而是写当前仓库的 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`，并维护可提交的 project artifact identity metadata。

常用短选项示例：

```bash
aw install git-commit -p codex -s user
aw install git-commit -p codex -s project
```

`aw init` 用来预热远程 catalog 和 artifact cache。它会先读取 `@yiliang/aw-plugins-manifest`，再获取同版本 `@yiliang/aw-plugins` 并校验 digest；它不安装插件、不升级插件、不写 install record，也不主动 materialize 本机 native runtime。需要 user scope native runtime 的写命令会在真正调用平台前同步 active runtime；纯 Codex project 路径只读使用 current catalog，不会为了写当前仓库产物去注册用户级 Codex runtime。绑定真实插件 target 的写入型命令需要显式传 `-p codex|claude|both`。

常用排障命令：

```bash
aw status git-commit --verbose
aw repair git-commit -p codex -s project
aw repair git-commit -p codex -s project --adopt-existing
aw repair --dependency-index
aw cleanup git-commit -p codex -s project --plan
aw cleanup git-commit -p codex -s project --plan --json
aw cleanup git-commit -p codex -s project
aw cleanup git-commit -p codex -s project --remove-config
aw cleanup --dependency-index --prune-stale <token> --yes
aw reinstall git-commit -p codex -s user
aw config list codex-explore -s user
aw config set codex-explore explorerModel gpt-5.4-mini -s user
aw config unset codex-explore modelReasoningEffort -s user
aw config reset codex-explore -s user --yes
aw config set git-commit aw.skillTriggers.commit.trigger manual -s user
```

`aw cleanup --plan --json` 是只读预览，输出 `cleanupPlanSchemaVersion: 1`，可在真正清理前查看 planned removals、would backups、would remove config、skipped foreign items、affected dependents、blocking reasons 和建议命令。`--remove-config` 只用于 `uninstall` / `cleanup` 主体成功后删除当前 target 的 AW 自管配置；只想删除配置时使用 `aw config reset`。

触发策略不再是安装、升级、修复或重装参数。作者在 manifest 里声明每个 skill 的 `defaultTrigger` 和 `allowDynamicTrigger` 后，用户通过 `aw config` 或主控制台配置页调整 `aw.skillTriggers.<skill>.trigger`；如果 runtime 与当前配置不一致，用 `aw repair <plugin> -p <platform> -s <scope>` 脚本化重放配置。

## 当前插件

| 插件 | 说明 | 支持平台 |
|------|------|----------|
| `git-commit` | 在用户请求提交时，按约定式提交规范完成 Git 提交 | Codex / Claude Code |
| `codex-explore` | 为 Codex 提供通用只读探索流程 | Codex |

`codex-explore` 是 Codex 通用只读探索 workflow，可用于代码库、文档、网络资料、日志和用户材料的证据搜索与总结；具体能访问哪些来源取决于当前会话工具、权限、联网策略和用户提供的上下文。

## 开发

```bash
make install
make build
make test
```

常用命令：

- `make build`：编译 `@yiliang/aw`，并生成本地 catalog staging / runtime bundle
- `make test`：运行单元测试和集成测试
- `make verify-local`：校验 CLI 本地发布链路（常规测试、build smoke、CLI pack smoke、catalog fetch smoke）
- `make verify-cli`：校验 CLI-only 发布链路
- `make verify-catalog`：校验 catalog-only 发布链路
- `make verify-release`：校验 CLI + catalog 组合发布链路
- `make pack-cli`：输出 CLI tarball 到 `.release/tarballs/`
- `make pack-catalog CATALOG_VERSION=1.2.0-beta.1`：输出 sidecar/full catalog tarball
- `make pack CATALOG_VERSION=1.2.0-beta.1`：同时输出 CLI 与 catalog tarball
- `make local-install`：打包 CLI 并执行本地 `npm install -g`，验证最终安装链路
- `make beta-release CLI_VERSION=1.0.0-beta.17 CATALOG_VERSION=1.2.0-beta.1`：校验并发布 CLI 测试版和 beta catalog
- `make release CLI_VERSION=1.0.0 CATALOG_VERSION=1.2.0`：校验并发布 CLI 正式版和 latest catalog

如果更习惯直接调用脚本，也可以使用：

- `pnpm run release:local`：本地开发安装流程
- `pnpm run release:pack:cli`：生成 CLI tarball
- `pnpm run release:pack:catalog -- --catalog-version 1.2.0-beta.1`：生成 catalog tarball
- `pnpm run release:publish:cli:beta` / `pnpm run release:publish:cli:latest`：只发布当前已经写入版本的 CLI 包
- `pnpm run release:publish:catalog:beta -- --catalog-version 1.2.0-beta.1`：只发布 beta catalog
- `pnpm run release:publish:beta -- --cli-version 1.0.0-beta.17 --catalog-version 1.2.0-beta.1`：组合发布测试版
- `pnpm publish:cli`：发布当前已经写入的正式版 CLI，兼容旧入口

## 本地开发与发版流程

推荐按下面三条路径区分使用：

### 1. 本地开发验证

```bash
make local-install
aw init --force
```

这条链路会先跑 CLI 发布校验，再生成 CLI tarball，并用 `npm install -g` 安装本地包。安装完成后，如果需要刷新 `~/.aw` 里的 catalog cache，再执行一次 `aw init --force`。

### 2. 测试版发布

```bash
make beta-release CLI_VERSION=1.0.0-beta.17 CATALOG_VERSION=1.2.0-beta.1
```

这条链路会同步根目录和 `packages/cli/package.json` 的 CLI 版本，校验 beta catalog version，跑 CLI + catalog 发布校验，并以 `beta` dist-tag 发布两类包，适合灰度验证和联调。

### 3. 正式版发布

```bash
make release CLI_VERSION=1.0.0 CATALOG_VERSION=1.2.0
```

正式版的 CLI version 和 catalog version 都必须是 stable SemVer，不允许带 prerelease 后缀。流程会同步 CLI 版本、校验 catalog 版本、执行完整校验，并把 CLI 与 catalog 包发布到 `latest`。

## 仓库结构

- `packages/cli/`：发布包 `@yiliang/aw` 的源码、测试和 build 脚本
- `plugins/`：插件源码，只维护 `.agents-plugin/plugin.json`、`marketplace-source.json` 和插件能力文件
- `scripts/release/`：版本同步、CLI / catalog tarball 打包、本地安装和发布编排脚本
- `.agents/skills/create-agent-workflows-plugin/`：创建和维护插件的作者工具
- `docs/`：公开架构、安装、测试和作者文档
- `docs/dev/`：开发过程记录，不作为公开使用文档

`CLAUDE.md` 是指向 `AGENTS.md` 的符号链接，用来让 Codex 和 Claude Code 共用同一份项目指令。

## 文档

- `docs/plugin-installation.md`：安装、升级、状态检查和排障
- `docs/plugin-authoring.md`：插件 manifest、hooks、skill trigger 与 scope 语义
- `docs/architecture.md`：CLI 源码布局和三层分发模型
- `docs/coding-conventions.md`：TypeScript 风格、边界和关键类型
- `docs/testing.md`：测试分层和提交前检查

## 生成物原则

插件源码层以 `plugins/<name>/.agents-plugin/plugin.json` 为真值。`packages/cli/plugins-dist/` 是本地 build / catalog 打包用的 staging 产物，不是 CLI tarball 的正式插件兜底；`packages/cli/dist/`、`packages/cli/coverage/`、`.release/` 和本机 `~/.aw/` 都是生成或运行时目录，不手工维护。
