# Testing Guidelines

`pnpm test` 使用默认 Vitest 配置，只运行 unit 和 integration 测试。Performance 和 smoke 测试使用下方的独立命令，不包含在 `pnpm test` 中。

## Test Layers

| 层 | 命令 | 责任 |
|----|------|------|
| Unit | `pnpm test:unit` | 纯函数、manifest、cache、ownership、receipt、status、config 和 rebuild 编排 |
| Integration | `pnpm test:integration` | CLI 入口、作者工具、五个写命令和平台 adapter 组合 |
| Performance | `pnpm test:perf` | 独立性能预算；不进入普通 unit |
| Performance gate | `pnpm test:perf:gate` | 预算结果和 fast unit wall-time 门禁 |
| Smoke | 见下方命令表 | 真实 build、pack、fetch 和插件脚本产物 |
| Plugin test | `pnpm plugin:test <plugin>` | 插件自己的确定性 Node 测试 |
| Plugin eval | `pnpm plugin:eval <plugin> --skill <skill> --batch-name <name>` | 为一个 owner Skill 通过中央 driver 显式运行模型 eval；不进入普通 CI |

### Coverage and Smoke Commands

| 命令 | 责任 |
|------|------|
| `pnpm test:coverage` | 运行默认 unit/integration 测试并生成覆盖率报告 |
| `pnpm test:smoke` | 运行完整 smoke suite |
| `pnpm test:smoke:build` | 校验 `pnpm build` 产物 |
| `pnpm test:smoke:pack:cli` | 校验 CLI tarball 内容 |
| `pnpm test:smoke:pack:catalog` | 校验 sidecar/full catalog tarball 内容 |
| `pnpm test:smoke:pack` | 串行校验 CLI 与 catalog tarball |
| `pnpm test:smoke:fetch` | 校验 sidecar/full catalog fetch、channel/version 选择、current catalog cache 复用，以及不兼容 catalog 直接失败且不下载 full tarball |
| `pnpm test:smoke:plugin-scripts` | 校验真实插件脚本 staging、依赖闭包和 bundle 布局 |

普通测试使用 synthetic catalog、隔离 home 和 fake native runner。不得调用用户真实 Codex/Claude 配置，也不得修改仓库外状态。

## Build Reuse

`scripts/build/ensure-cli-build.mjs` 只在输入、输出和 package identity 都匹配 generation stamp 时复用 build。并发 build 使用 lock；测试覆盖输入变化、输出变化、symlink、并发 owner 和 snapshot 隔离。

常规 unit/integration 不应隐式执行 package manager。真实依赖安装、build 后 production closure 和 tarball 内容进入 smoke。

## Current State Contracts

### Five write commands

`install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 必须覆盖同一条 rebuild pipeline：

- target 归一化和平台版本门禁
- current catalog 解析
- live ownership 检查
- stale AW-owned 组件删除
- native 和 repo-managed 写入
- lifecycle active prepare/promote/remove
- 完成后 live ownership 检查
- receipt v3 和退出码

关键行为：

- `cleanup` 不运行 uninstall lifecycle。
- `reinstall` 清理后按 current catalog 完整重建。
- `uninstall`、`cleanup` 和 `reinstall` 保留 config。
- 只有 `config reset` 删除 config store。
- 写命令测试只构造 current catalog、live owner 和平台组件 fixture。

### Live status and console

status 测试只允许 `present`、`absent`、`partial`、`error`。至少覆盖：

- 全部期望 owner 组件存在时为 `present`
- 没有 owner 组件时为 `absent`，建议 install
- 部分组件存在时为 `partial`，建议 reinstall
- 某个检查失败时为 `error`，其它 target 继续返回
- catalog 不可用和 bundle 不可用分开报告
- status 不运行 lifecycle/renderer，不写 marketplace 或 config
- console loader 使用同一份 status v3，不建立第二套状态矩阵

`status --json` 使用 `schemaVersion: 3`。stdout 只包含一个 JSON 对象；verbose/debug 和错误说明写 stderr。

### TUI and structured progress

TUI 单元和入口测试必须使用真实 Ink mount，并覆盖以下合同：

- 裸 `aw` 的宽/窄 viewport 退化、区域/单页导航和终端尺寸生命周期
- 写命令与 config 缺参向导的确认、运行前取消，以及运行中 `Ctrl-C` 完成后退出
- `rebuild:action` 的 start/终态配对、顺序、duration、source target 和失败后的 recovery/cleanup
- 多 target 更新当前 target 时不串线；当前阶段来自真实动作，不显示百分比
- 最近 8 条可见消息、50 条内存上限、notice/warning/failure 和结果页保留
- sensitive config、event message 和 native raw invocation/data 不进入 frame、stdout 或 stderr
- session reporter 在 TUI 结束后恢复；debug logger 对每个事件仍只接收一次

相关定向命令：

```bash
pnpm --filter @lesliechan721/aw exec vitest run tests/unit/rebuild-operations.test.ts tests/unit/rebuild-progress.test.ts tests/unit/console.test.tsx tests/unit/tui-real-progress.test.tsx tests/unit/wizard.test.tsx tests/unit/wizard-entry.test.tsx
pnpm --filter @lesliechan721/aw exec vitest run tests/integration/write-commands.test.ts tests/integration/cli-entry-json-harness.test.ts
```

JSON harness 必须继续断言 v3 schema、单一 stdout 对象和 stderr 诊断边界。测试使用隔离 home、synthetic catalog 和 fake native runner，不调用真实用户平台命令。

### Config

配置测试覆盖 manifest default、user、project shared 和 project local 合并。project repo-visible artifact 不得受 user、project local 或路径型私有值影响。

- `config list/get --json`：`configSchemaVersion: 3`
- `config set/unset/reset --json`：`receiptSchemaVersion: 3`
- set/unset 后对当前可定位 target 运行完整 reinstall
- reset 是唯一 config store 删除入口
- sensitive value 不进入 receipt、stderr 或 debug log

### Manifest dependencies

source manifest 和 catalog entry 遇到顶层 `dependencies` 必须明确报 `unsupported`。测试不再构造 plugin dependency graph、planner 或删除保护。

## Strict Catalog Cache Regression

`tests/unit/local-marketplace.test.ts` 必须保留底层 cache 测试，不依赖安装状态 fixture。至少覆盖：

- cache entry 按 identity 写入和读取
- selector index 按 registry source identity 隔离
- 较新的 remote observation 不被较旧完成结果覆盖
- 并发 immutable writer 不向 reader 暴露部分 entry
- lock deadline、abort 和 owner token 释放边界
- 冲突 observation 不污染已提交 entry
- corrupt entry 被隔离，后续 writer 能正常发布
- active marketplace 重建保留 strict cache
- cache 缺失或损坏不阻断 marketplace 重建
- marketplace 原子替换失败时，原 cache 仍完整可读

cache 测试只构造 cache、lock、selector 和 marketplace fixture。

## Performance Budgets

性能测试在 `packages/cli/tests/perf/`。每个预算必须输出一条：

```text
AW_PERF_SUMMARY {"name":"..."}
```

当前必须有且只能由对应预算产生以下名称：

- `catalog-cache-first-warm`
- `catalog-cache-first-after-marketplace-rebuild`
- `live-status-console-warm`
- `catalog-remote-deadline`

预算覆盖：

| 名称 | 场景 |
|------|------|
| `catalog-cache-first-warm` | 严格验证后的 disk cache-first P95 |
| `catalog-cache-first-after-marketplace-rebuild` | active marketplace 重建后的第一次 cache read |
| `live-status-console-warm` | live owner fixture 上 status 和 console warm chain P95 |
| `catalog-remote-deadline` | pending remote source 的有界 deadline |

`scripts/perf/run-perf-gate.mjs` 必须解析 summary，并校验名称集合与预期完全一致。没有 summary、缺少名称、重复名称或出现未知名称都必须让门禁失败。

性能预算使用宽松、跨平台的上限。它们用于发现数量级回退，不用于比较微小波动。失败时先确认机器负载，再检查 remote call 次数、重复 catalog 校验、cache publication 和 live component probe 数量。

## Test Isolation

- 使用测试提供的隔离 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 workspace。
- 平台命令使用 fake native runner。
- 需要进程树检查的测试在允许 POSIX/Windows 进程检查的环境运行。
- 测试结束后清理自己的临时目录和 mock。
- 不读取或改写真实 home、全局 native plugin 或真实项目配置。

## Platform Capability Regression

保留以下能力测试：

- Codex/Claude skills 和原生调用 metadata
- MCP server 写入和 ownership
- hooks、permissions、roles、instructions 和 agents
- slash commands 的 Claude command / Codex manual-only skill 输出
- Codex project scope 无 user native side effect
- Codex user native marketplace/plugin invocation
- Claude user/project settings 和 skill 输出
- apps 的支持和 scope 边界

这些能力测试验证平台输出，不建立独立安装健康数据库。

## Plugin Authoring Tests

作者工具测试必须锁住：

- manifest 顶层 `dependencies` 明确 unsupported
- source/platform manifest 的允许字段
- ArtifactPlan v2、artifact target 和 sourceDirs
- lifecycle/config helper/context
- Skill 原生调用 metadata
- bundle staging 和平台裁剪
- eval manifest、trigger corpus 和 materialized Codex artifact

作者 references、示例和 eval prompt 必须使用 live owner/status 术语。

## Plugin Eval

`pnpm plugin:eval` 只提供 Codex 证据。`--skill` 必填，一次只运行一个 owner Skill；不支持插件级 `--all`。每次运行必须用 `--batch-name <name>` 新建批次，或用已有输出中的 `--batch-id <id>` 恢复或追加同一批次。owner manifest 可以用 `skills[]` 声明同一 subject 的 participant Skills，并用 `profiles[].plugins[]` 按顺序安装当前仓库中的多个插件。该组合只用于 eval，不形成 production dependency。默认 materialize 所有 profile，并运行所有 `requiredForRelease` suite/split。使用 suite/profile/split/case 过滤，或减少 runs 时，单次结果固定为 incomplete；低于 `defaultRuns` 的 target 也固定为 incomplete。同一源码、materialization subject、模型环境、中央 harness、case 集和 target 合同的多个局部运行可由批次汇总计算 release target 覆盖；incomplete target 可补跑，声明 `cases` 的 suite 可由完整 case 集组合 `/all` target，历史 attempt 和失败 run 保留为 provenance。materialize-only 批次允许由首个真实模型运行固定模型环境。静态 Skill runner 执行 `packages/cli/dist` 驱动，因此真实运行前先执行 `pnpm build`，harness 摘要也以该构建产物和当前 review runner 为准。

真实模型运行使用隔离 runtime home，并固定使用文件凭据存储且关闭 secret keychain storage。provider credential 不进入模型 shell，所有 eval 证据必须脱敏。临时 runtime capsule 在成功、失败和中断后清理。

`trigger` 和 `conversation` suite 支持 `isolation: standard|strict`。conversation driver 在 Default 协作模式启用 `request_user_input`。`scripted_replies` 是 current 行为断言；baseline 的步骤、问题数或未消费回复差异只作为对照证据，不能使 required suite 机械失败。baseline 的完成、隔离、宿主源码访问和 workspace 安全仍是机械门禁。trigger driver 观察所有 participant Skills；单目标用例使用 `should_load_skill`，相邻 Skill 路由使用 `expected_loaded_skills` 精确集合。trigger 遇到 `request_user_input` 等待时正常结束，不把正确澄清记为 timeout。strict current 只保留 suite 的 participant Skills；baseline 只移除 owner Skill，并保留 companions。conversation 模型工作副本位于源码树外；runner 审计 trace，发现 current 或 baseline 读取宿主 participant 源码时机械失败。strict 模式关闭内置 Skill、插件、Apps、MCP 和建议类表面，并在运行前验证有效配置、精确 participant Skill 集合和空 MCP 清单。检查失败时结果必须是 incomplete。`strictNegativeSplits` 对任何一次负例误加载或错误委派零容忍。

conversation case 默认只读。执行写入型作者任务时，case 必须显式使用 `sandbox: workspace-write`，并声明最小 `allowed_workspace_changes` 与 `artifacts`。runner 只写隔离临时副本，禁写 eval 控制目录，并把越界 diff、缺失文件、文本或 JSON 断言失败作为 mechanical failure；current 与 baseline 都保存 workspace diff 和 artifact digest。

真实模型 eval 应从普通 Terminal 运行；macOS 检测到 `accountsKeychainExport` 包装器路径时会在启动模型前失败，且不会修改用户 keychain search list。入口先检查原始 `CODEX_PERMISSION_PROFILE`。`workspace` 或 `read-only` 来源没有显式降级参数时，必须在 keychain 检查、进程树探测、报告分配和模型启动前阻断。单次 `sandbox_permissions=require_escalated` 不等于 Full Access，不得用提权后的探测成功建立 `managed` 证据。用户明确传 `--allow-unmanaged-processes` 时，受限来源直接进入 `unmanaged-confirmed` 并跳过进程树探测。Windows 当前没有 Job Object containment，因此也必须显式传该参数。降级模式只清理直接子进程，报告必须记录 `descendantCleanupGuaranteed: false`。CLI 不能证明参数由人添加；人工确认必须由 Codex 审批或 UI 层保证。

case-capable suite 在每个 case 的全部 repetitions 后发布原子检查点。case 为 `incomplete` 时当前运行停止。同一 `--batch-id` 的下一次运行复用 terminal case，并重跑 incomplete 或 missing case；未完成 case 的全部 repetitions 会重新运行。没有 case 合同的 suite 仍整体重跑。真实模型 eval 可能运行几十分钟到数小时。调用方应保留同一个进程 session，并在首轮和后续等待中直接使用工具允许的最长响应式等待时间。等待超时不是 eval 失败。不要使用短周期 wait，也不要另开 `sleep`、`ps`、报告文件、Git 或其它状态轮询命令。

插件完整 eval 批次固定在 `.tmp/agent-workflows/evals/plugin/<plugin>/<skill>/<batch-id>/`；静态 Skill 使用 `.tmp/agent-workflows/evals/static/<skill>/<batch-id>/`。批次内保存 run、target、raw、scorecard 和自动汇总；只有 `work/<run-id>/` 在单次命令结束后清理。用户明确要求发布时执行 `review:publish`；插件正式报告写到 `plugins/<plugin>/reports/<skill>/<batch-id>/{report.md,summary.json}`，静态 Skill 写到 `.agents/reports/<skill>/<batch-id>/{report.md,summary.json}`。构建、安装和 runtime digest 排除 Skill `evals/**` 与插件 `reports/**`，但保留 Skill README。

`review:publish` 不更新 Skill README。用户另行明确要求登记时，使用 `review:release` 更新已经发布的 full/release 报告记录。插件 Skill README 登记属于 production source 变化，必须由 release intent 覆盖；普通 eval 不产生可提交报告。

## Pre-commit Checklist

- 改 rebuild/write/status/config → 运行相关 unit、integration 和 build
- 改 strict cache 或 selector → 运行 `local-marketplace.test.ts`、plugin catalog 测试、perf 和 fetch smoke
- 改平台输出 → 运行对应平台 unit/integration
- 改作者合同 → 运行 authoring-tools integration 和必要 plugin materialize
- 改 build/tarball → 运行对应 smoke
- 改公开 JSON → 同步检查 receipt v3、status v3、config v3 文档和 CLI JSON harness
- 最后运行 `git diff --check`
