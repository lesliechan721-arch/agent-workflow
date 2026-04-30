# Agent Workflows

Agent Workflows 是一个面向 Codex 和 Claude Code 的插件工作流仓库。这里维护插件源码、作者工具和发布为 `@yiliang/aw` 的 CLI；CLI 会把仓库内插件打包成 embedded bundle / 本机 marketplace，并按平台和 scope 安装到对应位置。

## 快速使用

```bash
npm install -g @yiliang/aw
aw init
aw install git-commit
aw status
```

也可以直接运行交互式安装，从候选列表里选择插件、平台和 scope：

```bash
aw install
```

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
| `git-commit` | 在用户要求提交当前改动时触发 Conventional Commits 提交流程 | Codex / Claude Code |

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

常用命令：

- `pnpm build`：编译 `@yiliang/aw`，并生成 `packages/cli/plugins-dist`
- `pnpm test:unit`：运行单元测试
- `pnpm test:integration`：运行 CLI 编排和 adapter 集成测试
- `pnpm test:smoke:build`：验证真实 build 产物
- `pnpm pack:cli`：打包 `@yiliang/aw`
- `pnpm publish:cli`：先执行 `pnpm pack:cli` 验收 tarball，再发布到 `packages/cli/package.json` 的 `publishConfig.registry`

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

插件源码层以 `plugins/<name>/.agents-plugin/plugin.json` 为真值。`packages/cli/plugins-dist/`、`packages/cli/dist/`、`packages/cli/coverage/` 和本机 `~/.aw/` 都是生成或运行时目录，不手工维护。
