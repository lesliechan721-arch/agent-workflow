# Agent Workflows

Agent Workflows 是一个面向 Codex 和 Claude Code 的插件工作流仓库。这里维护插件源码、作者工具和发布为 `@lesliechan721/aw` 的 CLI；插件通过 `@lesliechan721/aw-plugins-manifest` sidecar 包和 `@lesliechan721/aw-plugins` full catalog 包分发。CLI 解析当前 catalog，把插件按平台和 scope 安装到 Codex / Claude Code 对应位置。

本文是项目入口，负责 CLI 快速使用、仓库级开发入口和发版路径。系统合同、编码规则、测试规则和插件专用工作流按下方[文档职责](#文档职责)分别维护。

## 快速使用

需要 `Node.js >= 22`。

```bash
npm install -g @lesliechan721/aw
aw init
aw install git -p both
aw status
```

直接运行 `aw` 会进入响应式 Ink 插件管理仪表盘，从同一个入口完成安装、升级、配置、卸载、清理、重新应用配置和状态排查。宽终端同时显示插件、操作和目标/状态；窄终端退化为单栏页面，空间不足时提示调整终端尺寸。状态位于目标详情层，写操作位于操作层，配置位于插件的配置页。使用方向键或 `j/k` 移动，`Tab` 或 `h/l` 切换区域，`Enter` 选择，`Esc` 或 `b` 返回，`r` 刷新，`q` 退出；输出较长时使用 `PgUp/PgDn`。

`install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 五个写命令，以及缺少必要参数的 `config` 命令，只在真实 TTY、human 输出且非 CI 时进入轻量向导。参数完整时直接执行；CI、非 TTY 和 `--json` 始终使用确定性脚本路径。向导开始运行前可以取消；写入开始后的 `Ctrl-C` 不终止正在进行的写入，而是在当前操作完成后退出。

```bash
aw
```

脚本化写命令默认输出只展示用户能理解的完成结果和下一步；需要机器合同时加 `--json`，stdout 会是单一 JSON receipt。`--verbose` 展开诊断到 stderr，`--debug` 生成脱敏 debug log 并隐含 verbose。仪表盘和向导在运行页显示当前 target、真实 rebuild 阶段、已用时和最近消息，不显示百分比。该结构化进度是内部 human/TUI 事件通道，不进入 receipt，也不改变 JSON 合同；普通 human 模式不会额外打印事件，verbose 事件只写 stderr。五个写命令的 receipt 使用 schema v3。`aw status --json` 使用 schema v3，只按现场 ownership 和平台组件报告 `present`、`absent`、`partial`、`error`。配置读写合同也使用 config v3。

`install`、`uninstall`、`upgrade` 默认写入 user scope；需要项目级产物时再显式传 `-s project`。Codex project scope 不会启用用户级 native plugin，而是写当前仓库的 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`。这些文件中的 AW owner marker 提供写入和清理边界。

常用短选项示例：

```bash
aw install git -p codex -s user
aw install git -p codex -s project
```

`aw init` 用来预热远程 catalog 和 artifact cache。它会先读取 `@lesliechan721/aw-plugins-manifest`，再获取同版本 `@lesliechan721/aw-plugins` 并校验 digest；它不安装或升级插件，也不主动 materialize 本机 native runtime。需要 user scope native runtime 的写命令会在真正调用平台前同步 active runtime；纯 Codex project 路径只读使用 current catalog，不会为了写当前仓库产物去注册用户级 Codex runtime。绑定真实插件 target 的写命令需要显式传 `-p codex|claude|both`。

`aw status` 和主控制台首页优先使用合法的 catalog cache；安装、升级和普通初始化会检查远程 catalog。`aw init --force` 跳过 cache 快路径并强制尝试远程刷新；如果 resolver 只能返回 cache fallback，命令会拒绝该结果并报错。

常用排障命令：

```bash
aw status git --verbose
aw cleanup git -p codex -s project
aw reinstall git -p codex -s user
aw config list codex-enhance -s user
aw config set codex-enhance standardModel gpt-5.6-terra -s user
aw config set codex-enhance standardReasoningEffort max -s user
aw config set codex-enhance planningReviewTaskModel gpt-5.6-sol -s user
aw config set codex-enhance planningReviewTaskReasoningEffort xhigh -s user
aw config set codex-enhance minimumInitialWaitMinutes 15 -s user
aw config unset codex-enhance minimumInitialWaitMinutes -s user
aw config reset codex-enhance -s user --yes
```

`aw cleanup` 删除当前 target 中带有效 AW ownership 的现场组件，不运行 uninstall lifecycle。`aw reinstall` 先清理 AW-owned 组件，再按 current catalog 重建。`uninstall`、`cleanup` 和 `reinstall` 都保留 AW 自管配置；配置只由 `aw config reset` 删除。最后一次成功 lifecycle 输入单独保存在 lifecycle active store 中，只供下一次 uninstall 运行对应脚本；它不是安装状态账本。

Skill 的触发行为只由平台原生元数据决定。Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`；Claude Code 使用 `SKILL.md` frontmatter 的 `disable-model-invocation` 和 `user-invocable`。AW 在安装、升级和动态刷新时校验并保留这些值，不提供 CLI、配置页或 manifest 覆盖项。显式调用入口不受影响。

## 当前插件

| 插件 | 说明 | 支持平台 |
|------|------|----------|
| `ask-me` | 实施前澄清会影响结果或造成返工的关键歧义，并协作制定、比较或评审计划与重要决策 | Codex / Claude Code |
| `git` | 在用户请求提交时，按用户或仓库适用规范完成 Git 提交 | Codex / Claude Code |
| `codex-enhance` | 通过通用只读探索和已授权子代理编排两个 Skill 增强 Codex | Codex |

`codex-enhance` 提供 `codex-explore` 和 `codex-subagent-guide` 两个 Skill。`codex-explore` 是 Codex 通用只读探索 workflow，可用于代码库、文档、网络资料、日志和用户材料的证据搜索与总结；具体能访问哪些来源取决于当前会话工具、权限、联网策略和用户提供的上下文。

`codex-explore` 按探索深度提供 quick、standard 和 deep 三档预设 role，无法明确分档时使用 standard。每档 role 的 model 和 reasoning effort 都能独立配置，默认分别为 `gpt-5.6-luna/medium`、`gpt-5.6-luna/high` 和 `gpt-5.6-luna/xhigh`。用户显式指定 model 或 reasoning effort 时改用不锁定参数的 custom role，只透传用户指定的字段。

代码 review、缺陷分析、质量判断、修改和实现任务只要能分离出值得隔离的大范围只读事实探索，也可以使用该 workflow；探索子代理不负责最终判断、建议或写操作。

`codex-subagent-guide` 不决定是否应该使用子代理，也不授予委派权限；它同等兼容 Codex multi-agent V1/V2，但不预判工具版本，而是按当前公开的工具和 schema 应用 model/effort、fork、响应式等待与条件清理原则。它按最终交付物区分简单、通用、复杂、计划与审核四类任务，并为每类分别生成可配置的默认 model 和 reasoning effort；`minimumInitialWaitMinutes` 可动态调整首次响应式等待窗口下限。

## 开发

```bash
make install
make build
make test
```

推荐入口：

- `make build`：编译 `@lesliechan721/aw`，并生成本地 catalog staging / runtime bundle
- `make test`：运行单元测试和集成测试
- `make verify-local`：校验 CLI 本地发布链路（常规测试、性能门禁、build smoke、CLI pack smoke、catalog fetch smoke）
- `make verify-cli`、`make verify-catalog`、`make verify-release`：分别校验 CLI、catalog 或组合发布链路
- `make local-install`：打包 CLI 并执行本地 `npm install -g`，验证最终安装链路
- `make beta-release CLI_VERSION=1.0.0-beta.17 CATALOG_VERSION=1.2.0-beta.1`：校验并发布 CLI 测试版和 beta catalog
- `make release CLI_VERSION=1.0.0 CATALOG_VERSION=1.2.0`：校验并发布 CLI 正式版和 latest catalog

测试层级和完整验证命令见[测试指南](docs/testing.md)。插件创建、确定性测试、模型 Eval 和评审入口见[插件维护指南](docs/plugin-maintenance.md)。

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

新插件保留初始稳定 version。已有插件的 production 变化直接提高源码 manifest version。Beta 发布根据该稳定版本、插件内容摘要和已发布账本，在临时 staging 中生成 `x.y.z-beta.N`，不修改源码 manifest。

### 3. 正式版发布

```bash
make release CLI_VERSION=1.0.0 CATALOG_VERSION=1.2.0
```

正式版的 CLI version 和 catalog version 都必须是 stable SemVer，不允许带 prerelease 后缀。流程会同步 CLI 版本、校验 catalog 版本、执行完整校验，并把 CLI 与 catalog 包发布到 `latest`。

正式发布前运行 `pnpm plugin:version:check -- --base <git-ref>` 并重新构建。正式 catalog 直接使用源码 manifest 中已经确定的稳定插件版本。

## 仓库结构

- `packages/cli/`：发布包 `@lesliechan721/aw` 的源码、测试和 build 脚本
- `plugins/`：插件源码，只维护 `.agents-plugin/plugin.json`、`marketplace-source.json` 和插件能力文件
- `scripts/release/`：版本同步、CLI / catalog tarball 打包、本地安装和发布编排脚本
- `.agents/skills/create-aw-plugin/`：创建、增量维护并检查插件版本的作者工具
- `.agents/skills/skill-review/`：只读评审标准静态 Skill 或 AW 插件 Skill，并核对最终 Codex 制品和 eval 证据
- `docs/`：公开维护文档
- `docs/dev/`：开发过程记录，不作为公开使用文档

`CLAUDE.md` 是指向 `AGENTS.md` 的符号链接，用来让 Codex 和 Claude Code 共用同一份项目指令。

## 文档职责

详细规则只在一个权威入口维护。其它入口只保留短摘要和链接。

| 入口 | 主要读者 | 责任 |
|------|----------|------|
| 本 README | 用户与维护者 | CLI 快速使用、核心开发入口和仓库级发版路径 |
| [架构说明](docs/architecture.md) | 维护者 | CLI 系统结构、模块边界和稳定产品合同 |
| [编码约定](docs/coding-conventions.md) | 维护者 | TypeScript 实现约定 |
| [测试指南](docs/testing.md) | 维护者 | 测试书写、层级选择和验证命令 |
| [插件维护指南](docs/plugin-maintenance.md) | 维护者 | 插件源码边界、维护入口和仓库级验证 |
| [create-aw-plugin README](.agents/skills/create-aw-plugin/README.md) | 维护者 | 插件作者 Agent 工作流的人类入口 |
| [skill-review README](.agents/skills/skill-review/README.md) | 维护者 | Skill 评审 Agent 工作流的人类入口 |
| [AGENTS.md](AGENTS.md) | Agent | 按任务路由到上述权威入口和专用 Skill |

## 生成物原则

插件源码层以 `plugins/<name>/.agents-plugin/plugin.json` 为真值。`packages/cli/plugins-dist/` 是本地 build / catalog 打包用的 staging 产物，不是 CLI tarball 的正式插件兜底；`packages/cli/dist/`、`packages/cli/coverage/`、`.release/` 和本机 `~/.aw/` 都是生成或运行时目录，不手工维护。
