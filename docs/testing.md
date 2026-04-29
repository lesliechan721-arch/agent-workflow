# Testing Guidelines

测试框架 Vitest，测试文件统一 `*.test.ts`，位于 `packages/cli/tests/` 下的 `unit/`、`integration/`、`smoke/`、`helpers/`、`fixtures/`。

## Test Layers

- **`unit/` 和 `integration/`** — 保持 build-free，不依赖预先存在的 `plugins-dist`；需要 runtime bundle 输入时，用 `tests/helpers/embedded-root.ts` 生成临时 synthetic embedded root
- **`smoke/`** — 专门验证真实 `pnpm build` 和 `pnpm pack:cli` 产物，不进入常规 `pnpm test`
- **`pnpm plugin:test <plugin>`** — 插件作者脚本测试入口，先 compile CLI，再运行已编译的 `packages/cli/scripts/test-plugin-scripts.js`；它使用 staging 临时 bundle，但不是 `aw` 客户端子命令
- **`fixtures/repo-template/`** — 含 `.codex/`、`.claude/` 等完整项目结构示例
- **`fixtures/codex-config/`** — Codex 配置示例

## Focus Areas

- CLI 命令入口：`tests/integration/cli-entry.test.ts` 覆盖 commander 参数、stdout/stderr 和退出码
- 命令编排与平台行为：`tests/integration/cli.test.ts`、`upgrade-command.test.ts`、`skill-trigger-command.test.ts`
- 作者工具：`tests/integration/authoring-tools.test.ts` 覆盖脚手架、校验脚本和作者文档关键约定
- Runtime 环境变量：`tests/integration/runtime-env.test.ts` 覆盖 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 等路径覆写
- 插件配置与脚本：`plugin-config.test.ts`、`plugin-scripts.test.ts`、`plugin-lifecycle-command.test.ts` 覆盖 AW config、lifecycle context/runner、status health 和命令接入

## Regression Contracts

CLI entry 测试优先通过 `CliRuntimeOptions` 注入 fake native runner、fake adapters、fake prompt、reporter 和 debug logger。不要为了普通集成测试依赖真实 `codex` 或 `claude` 可执行文件；只有明确验证 PATH 查找时才创建 stub binary。

交互式测试默认必须使用 fake prompt，且断言不会访问真实 stdin。窄例外只允许放在专门验证 readline prompt harness、TTY sink 或隐藏敏感输入的测试里；这类测试必须显式隔离 stdin/stdout/stderr，并证明 `--json` stdout 仍是单一可解析 JSON。`install`、`uninstall`、`upgrade` 的 prompt 返回值必须来自本轮候选列表；非法 candidate id、过期 token、候选外插件名、skip/空值或非法 skill trigger 都要在 runtime 层拒绝。

`aw config configure` 和 install/upgrade required config preflight 也必须通过 fake prompt 覆盖。fake prompt 要返回 `selectedScope`、`updates`、`updatedKeys` 和 `cancelled`；显式 `--scope user|project` 时，prompt 不能改写到另一层。切换写入层时只 patch dirty key，不能把 effective config 的整份 values 写入目标 store；取消时不能创建或修改任何 store。

交互式 `install` 需要覆盖平台兼容性和可安装性：`marketplace.policy.products` 过滤、`both` 下单平台插件禁用、显式多插件名共同兼容平台交集、无共同兼容平台时 dispatch 前失败，以及 fake prompt 返回不兼容平台时的拒绝。`Codex + project scope` 还要覆盖 `hasRepoManagedArtifacts(plugin)` 的候选过滤、空态、显式插件名早失败和正向可选插件。

degraded ledger 下，重复 `install` 和显式插件 `upgrade` 要覆盖交互式补问 `skill-trigger`、非交互确定性错误、`CI=true` / `--no-interactive` 不 prompt，以及非法 prompt 返回值。`--skill-trigger` CLI entry 回归要覆盖显式 `install`、显式插件 `upgrade` 的 `manual|auto|default` 正向透传，也要覆盖 `upgrade --all --skill-trigger` 和 `upgrade -a -t` 在入口层确定性拒绝。

Codex native marketplace 测试使用 fake native runner 断言 invocation 精确为 `codex plugin marketplace add <canonical AW_HOME>`。source 必须是 marketplace 根目录，不是 `.agents/plugins/marketplace.json`；local source 不带 `--ref`、`--sparse`，也不要求 `.tmp/marketplaces/aw` 存在。失败分支要覆盖 stderr、空输出、timeout、`ENOENT` 和 PATH 异常。

repo 子目录回归要分别覆盖 discovery、status、交互式 `uninstall/upgrade`：Codex project scope 证据锚定 repo root realpath；Claude project scope 证据锚定调用目录 realpath，不能混入 repo root 或兄弟目录。

historical placeholder 回归要覆盖 discovery、默认 status、交互式 `uninstall/upgrade` 候选。Codex ledger-only 的 `hasRepoManagedArtifacts: true` 不能恢复 hook、instruction、permission、agent 等具体 kind；tracking 明确记录 `kind: "hook"` 或 hook identity 时，才允许恢复 hook 能力。

status 测试要把默认、verbose、JSON、debug 通道分开锁住。`aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug` 的 stdout 都必须用 `JSON.parse` 验证纯度；verbose/debug 人类诊断只能出现在 stderr 或 debug log。unknown plugin 在 status 中应是 `notInstalled`，但执行型命令仍应报 `Unknown plugin`。

status skill-trigger 状态矩阵要覆盖 matched、equivalent defaults、mixed、drift、unknown 和 historical fallback，并分别断言默认视图不暴露 raw 字段名、verbose 可读展开、JSON 保留稳定机器字段。

stale 本地 marketplace 回归要断言 status 完全只读：`~/.aw` 缺失、`config.json` stale、marketplace 布局损坏或 ledger degraded 时，status 只读回退 embedded catalog；`--verbose` / `--json` 能看到 `source=embedded` 和本地目录不可用原因；测试要用文件存在性、mtime 或内容快照确认不会创建插件目录、修复 `~/.aw`、改写 `installed.json`、tracking manifest 或平台配置。

runtime env 贯穿测试要覆盖 direct command 与 `runCli(..., { env })` 两条入口。平台检测、ledger/current catalog 解析、home 路径、默认 adapter 创建、discovery 和 status 读取路径都必须消费注入 env，防止新 helper 悄悄回落到 `process.env`。

reporter/debug log 回归要覆盖默认输出稳定、中文 warning 有序去重、prepare / replay warning 先于 terminal error 输出、同一 prepare warning 一次命令只渲染一次，以及 debug log 对 token、password、secret、authorization、cookie 等敏感内容脱敏。`aw status --debug` 未传 `--log-file` 时不能创建或清理 `~/.aw/logs`。

AW config 回归要覆盖 default < user < project 的 effective 合并、未安装插件预配置、uninstall 保留配置、current catalog 缺失时 `reset --yes` 清理 raw store、非法插件名路径段拒绝、unknown keys 脱敏保留、`file` / `directory` 写入 realpath 和读取时重校验。config store 不能作为 discovery/status 的安装证据。

lifecycle 回归要覆盖 install/upgrade/uninstall 执行时机、失败阻断、`--script-timeout` 优先级、stdout/stderr 脱敏、Windows/POSIX env 分支、安装快照真值和快照 GC。status health 必须只读：它能展示 `healthSource`、config/script health 和 `invalid-config`，但不能执行脚本、刷新 marketplace、创建配置目录或修复 ledger。

`scripts.node` 相关测试要保持分层。unit/integration 默认使用 build-free synthetic embedded root，不运行 package manager、不执行 manifest build、不扫描真实 production dependency closure。真实 `pnpm install --frozen-lockfile --ignore-scripts`、manifest build、production `node_modules` 复制、runtime dependency install script 拒绝和 bundle layout 验收进入 smoke 或 opt-in runner，例如 `pnpm test:smoke:plugin-scripts`。

`pnpm plugin:test <plugin>` 运行单个插件时不处理其它坏插件；`pnpm plugin:test --all` 才会被任一插件失败阻断。runner 在临时 bundle、隔离 `AW_HOME` 和受管临时 project root 中执行 Node 测试；无 `scripts.tests.node` 匹配时输出 skipped/no tests matched 并以 0 退出，不调用 Node 默认测试发现。`--platform both` 要验证 Codex/Claude 两轮使用独立可写 bundle；测试入口从最终测试基准 manifest 的 glob 发现，test-only helper 由静态 import/require 递归复制，不能覆盖 runtime helper。

## Pre-commit Checklist

- 改命令分支、catalog 判定、账本、bundle 生成或打包行为 → 至少运行相关测试
- 改 build 或 tarball 行为 → 补跑 `pnpm test:smoke:build`，必要时再跑 `pnpm test:smoke:pack`
- 改 `scripts.node` staging、manifest build、runtime dependency closure 或 `pnpm plugin:test` → 补跑 `pnpm test:smoke:plugin-scripts`；维护具体插件脚本时可先跑 `pnpm plugin:test <plugin>`
- 正式发包时 → 直接执行 `pnpm publish:cli`；它会先跑 `pnpm pack:cli` 验收 tarball，再继续发布
- 改 plugin manifest contract、本地 marketplace 布局或作者工具 → 同步更新对应 fixture、样例插件和相关文档
- 只改公开文档 → 不必跑全量测试，但要至少检查 `AGENTS.md`、`README.md`、`docs/*.md` 没有继续引用过期路径或把 `docs/dev` 当作公开权威来源
