# Agent Workflows

Agent Workflows 是一个面向 Codex 和 Claude Code 的插件工作流仓库。这里维护插件源码、作者工具和发布为 `@lesliechan721/aw` 的 CLI；插件通过 `@lesliechan721/aw-plugins-manifest` sidecar 包和 `@lesliechan721/aw-plugins` full catalog 包分发。CLI 解析当前 catalog，把插件按平台和 scope 安装到 Codex / Claude Code 对应位置。

## 快速使用

需要 `Node.js >= 20`。

```bash
npm install -g @lesliechan721/aw
aw init
aw install git-commit -p both
aw status
```

直接运行 `aw` 会进入插件管理控制台，从同一个入口完成安装、升级、配置、卸载、清理、重新应用配置和状态排查。`install`、`uninstall`、`upgrade`、`config`、`status`、`cleanup`、`reinstall` 这些子命令保留给脚本化调用；非 TTY 或 CI 环境下直接运行 `aw` 会确定性失败，并提示可复制命令和 `--json` 输出入口。

```bash
aw
```

脚本化写命令默认输出只展示用户能理解的完成结果和下一步；需要机器合同时加 `--json`，stdout 会是单一 JSON receipt。`--verbose` 展开诊断到 stderr，`--debug` 生成脱敏 debug log 并隐含 verbose。五个写命令的 receipt 使用 schema v3。`aw status --json` 使用 schema v3，只按现场 ownership 和平台组件报告 `present`、`absent`、`partial`、`error`。配置读写合同也使用 config v3。

`install`、`uninstall`、`upgrade` 默认写入 user scope；需要项目级产物时再显式传 `-s project`。Codex project scope 不会启用用户级 native plugin，而是写当前仓库的 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`。这些文件中的 AW owner marker 提供写入和清理边界。

常用短选项示例：

```bash
aw install git-commit -p codex -s user
aw install git-commit -p codex -s project
```

`aw init` 用来预热远程 catalog 和 artifact cache。它会先读取 `@lesliechan721/aw-plugins-manifest`，再获取同版本 `@lesliechan721/aw-plugins` 并校验 digest；它不安装或升级插件，也不主动 materialize 本机 native runtime。需要 user scope native runtime 的写命令会在真正调用平台前同步 active runtime；纯 Codex project 路径只读使用 current catalog，不会为了写当前仓库产物去注册用户级 Codex runtime。绑定真实插件 target 的写命令需要显式传 `-p codex|claude|both`。

`aw status` 和主控制台首页优先使用合法的 catalog cache；安装、升级和普通初始化会检查远程 catalog。`aw init --force` 跳过 cache 快路径并强制尝试远程刷新；如果 resolver 只能返回 cache fallback，命令会拒绝该结果并报错。catalog deadline、cache TTL、原生命令 timeout 和离线 fallback 的完整合同见 [插件安装指南](docs/plugin-installation.md#catalog-与原生命令环境变量)。

常用排障命令：

```bash
aw status git-commit --verbose
aw cleanup git-commit -p codex -s project
aw reinstall git-commit -p codex -s user
aw config list codex-explore -s user
aw config set codex-explore standardModel gpt-5.6-terra -s user
aw config set codex-explore standardReasoningEffort max -s user
aw config set codex-explore minimumInitialWaitMinutes 15 -s user
aw config unset codex-explore minimumInitialWaitMinutes -s user
aw config reset codex-explore -s user --yes
aw config set codex-subagent-guide planningReviewTaskModel gpt-5.6-sol -s user
aw config set codex-subagent-guide planningReviewTaskReasoningEffort xhigh -s user
aw config set codex-subagent-guide minimumInitialWaitMinutes 15 -s user
```

`aw cleanup` 删除当前 target 中带有效 AW ownership 的现场组件，不运行 uninstall lifecycle。`aw reinstall` 先清理 AW-owned 组件，再按 current catalog 重建。`uninstall`、`cleanup` 和 `reinstall` 都保留 AW 自管配置；配置只由 `aw config reset` 删除。最后一次成功 lifecycle 输入单独保存在 lifecycle active store 中，只供下一次 uninstall 运行对应脚本；它不是安装状态账本。

Skill 的触发行为只由平台原生元数据决定。Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`；Claude Code 使用 `SKILL.md` frontmatter 的 `disable-model-invocation` 和 `user-invocable`。AW 在安装、升级和动态刷新时校验并保留这些值，不提供 CLI、配置页或 manifest 覆盖项。显式调用入口不受影响。

## 当前插件

| 插件 | 说明 | 支持平台 |
|------|------|----------|
| `ask-me` | 实施前澄清会影响结果或造成返工的关键歧义，并协作制定、比较或评审计划与重要决策 | Codex / Claude Code |
| `git-commit` | 在用户请求提交时，按用户或仓库适用规范完成 Git 提交 | Codex / Claude Code |
| `codex-explore` | 为 Codex 提供通用只读探索流程 | Codex |
| `codex-subagent-guide` | 在委派已获授权后按任务类型指导子代理参数、fork、响应式等待与条件清理 | Codex |

`codex-explore` 是 Codex 通用只读探索 workflow，可用于代码库、文档、网络资料、日志和用户材料的证据搜索与总结；具体能访问哪些来源取决于当前会话工具、权限、联网策略和用户提供的上下文。

`codex-explore` 按探索深度提供 quick、standard 和 deep 三档预设 role，无法明确分档时使用 standard。每档 role 的 model 和 reasoning effort 都能独立配置，默认分别为 `gpt-5.6-luna/medium`、`gpt-5.6-luna/high` 和 `gpt-5.6-luna/xhigh`。用户显式指定 model 或 reasoning effort 时改用不锁定参数的 custom role，只透传用户指定的字段。

代码 review、缺陷分析、质量判断、修改和实现任务只要能分离出值得隔离的大范围只读事实探索，也可以使用该 workflow；探索子代理不负责最终判断、建议或写操作。

`codex-subagent-guide` 不决定是否应该使用子代理，也不授予委派权限；它同等兼容 Codex multi-agent V1/V2，但不预判工具版本，而是按当前公开的工具和 schema 应用 model/effort、fork、响应式等待与条件清理原则。它按最终交付物区分简单、通用、复杂、计划与审核四类任务，并为每类分别生成可配置的默认 model 和 reasoning effort；`minimumInitialWaitMinutes` 可动态调整首次响应式等待窗口下限。

## 开发

```bash
make install
make build
make test
```

常用命令：

- `make build`：编译 `@lesliechan721/aw`，并生成本地 catalog staging / runtime bundle
- `make test`：运行单元测试和集成测试
- `pnpm test:perf:gate`：运行独立性能预算和 fast unit wall-time 门禁；预算定义见 [测试指南](docs/testing.md#performance-budgets)
- `pnpm plugin:test <plugin>`：运行插件确定性 Node 脚本测试，不调用模型
- `pnpm plugin:eval <plugin> --materialize-only`：生成并核验 Codex project/user 最终 Skill 制品，不调用模型
- `pnpm plugin:eval <plugin> --output-dir /tmp/aw-eval`：本地显式运行该插件 release-required Codex eval；不进入常规 CI
- `node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs <skill> --validate-only`：校验当前仓库静态 Skill eval 定义；真实模型运行使用同一脚本和显式 `--output-dir`
- `make verify-local`：校验 CLI 本地发布链路（常规测试、性能门禁、build smoke、CLI pack smoke、catalog fetch smoke）
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

- `packages/cli/`：发布包 `@lesliechan721/aw` 的源码、测试和 build 脚本
- `plugins/`：插件源码，只维护 `.agents-plugin/plugin.json`、`marketplace-source.json` 和插件能力文件
- `scripts/release/`：版本同步、CLI / catalog tarball 打包、本地安装和发布编排脚本
- `.agents/skills/create-agent-workflows-plugin/`：创建和维护插件的作者工具
- `.agents/skills/skill-review/`：只读评审标准静态 Skill 或 AW 插件 Skill，并核对最终 Codex 制品和 eval 证据
- `docs/`：公开架构、安装、测试和作者文档
- `docs/dev/`：开发过程记录，不作为公开使用文档

`CLAUDE.md` 是指向 `AGENTS.md` 的符号链接，用来让 Codex 和 Claude Code 共用同一份项目指令。

## 文档

- `docs/plugin-installation.md`：安装、升级、状态检查和排障
- `docs/plugin-authoring.md`：插件 manifest、hooks、Skill 原生调用元数据与 scope 语义
- `docs/architecture.md`：CLI 源码布局和三层分发模型
- `docs/coding-conventions.md`：TypeScript 风格、边界和关键类型
- `docs/testing.md`：测试分层和提交前检查

## 生成物原则

插件源码层以 `plugins/<name>/.agents-plugin/plugin.json` 为真值。`packages/cli/plugins-dist/` 是本地 build / catalog 打包用的 staging 产物，不是 CLI tarball 的正式插件兜底；`packages/cli/dist/`、`packages/cli/coverage/`、`.release/` 和本机 `~/.aw/` 都是生成或运行时目录，不手工维护。
