# Agent Workflows

Agent Workflows 是一个面向 Codex 和 Claude Code 的插件工作流仓库。这里维护插件源码、作者工具和发布为 `@yiliang/aw` 的 CLI；CLI 会把仓库内插件打包成 embedded bundle / 本机 marketplace，并按平台和 scope 安装到对应位置。

## 快速使用

```bash
npm install -g @yiliang/aw
aw init
aw install git-commit
aw status
```

直接运行 `aw` 会进入交互控制台，从同一个入口完成安装、升级、配置、卸载、重新应用配置和诊断。`install`、`uninstall`、`upgrade`、`config`、`status` 这些子命令保留给脚本化调用；非 TTY 或 CI 环境下直接运行 `aw` 会确定性失败，并提示可复制命令和 `--json` 输出入口。

```bash
aw
```

脚本化写命令默认输出只展示用户能理解的完成结果和下一步；需要机器合同时加 `--json`，stdout 会是单一 JSON receipt。`--verbose` 展开诊断到 stderr，`--debug` 生成脱敏 debug log 并隐含 verbose。`aw status` 默认使用友好状态摘要，`aw status --json` 保留矩阵字段并追加 `friendlySummaries` 和 `consoleItems`。

`install`、`uninstall`、`upgrade` 默认写入 user scope；需要项目级产物时再显式传 `-s project`。Codex project scope 是 repo-managed：不会启用用户级 native plugin，而是写当前仓库的 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` 和 tracking manifest。

常用短选项示例：

```bash
aw install git-commit -p codex -s user
aw install git-commit -p codex -s project
```

`aw init` 用来显式初始化 `~/.aw`，需要 native plugin runtime 的安装和升级命令也会在必要时自动同步本地 marketplace。纯 Codex project repo-managed 路径只读使用 catalog，不会为了安装当前仓库产物去修复或注册用户级 Codex marketplace。双平台都可用时，写入型命令如果无法从当前 scope 推断目标平台，需要显式传 `-p codex|claude|both`。

## 当前插件

| 插件 | 说明 | 支持平台 |
|------|------|----------|
| `git-commit` | 在用户请求提交时，按约定式提交规范完成 Git 提交 | Codex / Claude Code |
| `codex-explore` | 为 Codex 提供只读代码库探索流程 | Codex |

## 开发

```bash
make install
make build
make test
```

常用命令：

- `make build`：编译 `@yiliang/aw`，并生成 `packages/cli/plugins-dist`
- `make test`：运行单元测试和集成测试
- `make verify-local`：校验本地开发发包链路（`test` + `smoke build`）
- `make pack`：输出本地 tarball 到 `.release/tarballs/`
- `make local-install`：打包并执行本地 `npm install -g`，验证最终安装链路
- `make beta-release VERSION=0.2.0-beta.0`：同步测试版版本号并发布 `beta` tag
- `make release VERSION=0.2.0`：同步正式版版本号，跑完整校验后发布 `latest`

如果更习惯直接调用脚本，也可以使用：

- `pnpm run release:local`：本地开发安装流程
- `pnpm run release:publish:beta`：发布当前已经写入的测试版版本
- `pnpm publish:cli`：发布当前已经写入的正式版版本，兼容旧入口

## 本地开发与发版流程

推荐按下面三条路径区分使用：

### 1. 本地开发验证

```bash
make local-install
aw init --force
```

这条链路会先跑常规测试，再生成 tarball，并用 `npm install -g` 安装本地包。安装完成后，如果需要刷新 `~/.aw` 里的本机 marketplace，再执行一次 `aw init --force`。

### 2. 测试版发布

```bash
make beta-release VERSION=0.2.0-beta.0
```

这条链路会同步根目录和 `packages/cli/package.json` 的版本号，跑完整发布校验，并以 `beta` dist-tag 发布，适合灰度验证和联调。

### 3. 正式版发布

```bash
make release VERSION=0.2.0
```

正式版要求稳定 semver，不允许带 prerelease 后缀。流程会同步版本号、执行完整校验、重新打 tarball，并按 `packages/cli/package.json` 的 `publishConfig.registry` 发布到 `latest`。

## 仓库结构

- `packages/cli/`：发布包 `@yiliang/aw` 的源码、测试和 build 脚本
- `plugins/`：插件源码，只维护 `.agents-plugin/plugin.json` 和插件能力文件
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

插件源码层以 `plugins/<name>/.agents-plugin/plugin.json` 为真值。`packages/cli/plugins-dist/`、`packages/cli/dist/`、`packages/cli/coverage/`、`.release/` 和本机 `~/.aw/` 都是生成或运行时目录，不手工维护。
