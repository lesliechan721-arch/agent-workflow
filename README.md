# Agent Workflows

面向 **Codex** 和 **Claude Code** 的轻量、可组合 Agent 插件集合。

Agent Workflows 不试图把一种完整开发方法强加给所有任务。它把需求澄清、决策原型、结构化开发、Git 操作、证据探索、Agent 内容、Skill 工具和插件维护拆成独立能力：用户可以显式启动宏流程，模型也可以在任务中按需调用小型 Skill。

项目同时提供 `@lesliechan721/aw` CLI，用于发现、安装、刷新同步、配置和移除插件。

## 设计思想

- **Skill 保持薄而完整**：只补充模型容易缺失的判断、项目约定和高价值边界。
- **能力可以组合**：每个 Skill 负责一个连贯任务，不要求安装一套强制 SDLC。
- **用户控制宏流程**：会改变工作方式或产生重要副作用的入口保持显式。
- **机械工作交给工具**：安装、配置、物化和确定性校验由 CLI 或脚本完成。
- **状态留在项目中**：长期信息优先写入 Spec、Issue、PR、Git 和其它可恢复 artifact，而不是只留在对话里。
- **按风险增加保障**：小任务快速完成；复杂或高风险任务再增加澄清、规格、隔离、验证和独立审查。
- **通过 Eval 精简**：Skill 是否保留以及描述如何优化，应由真实任务的 with/without-skill 结果决定。

## 相对原生插件的优势

Codex 和 Claude Code 都有自己的原生 Skill、命令和插件能力。Agent Workflows 不替代这些机制，而是在其上提供统一的分发、组合和生命周期管理。

| 能力 | Agent Workflows 提供的增量 |
| --- | --- |
| 跨平台目录 | 同一插件源码面向 Codex 和 Claude Code，安装时保留各平台原生 invocation metadata |
| 统一管理 | 使用一个 `aw` CLI 完成发现、安装、刷新同步、配置、状态检查、清理和重建 |
| 两种安装范围 | User 与 Project 各有独立的 Intent v3 声明和本机部署偏好；每次恢复都明确选择范围 |
| 安全 ownership | 只更新或清理能够证明属于 AW 的组件，避免把平台目录中的其它内容误当作插件状态 |
| 动态原生产物 | 插件可以按平台和配置物化 Skill、Agent role、instructions、hooks 等平台能力 |
| 可选 Portable Skill 层 | 插件可在完整 native plugin closure 之外显式声明 Agent Skills 分发；该层是增量能力，不把原生 Skill 自动转换为 portable source |
| 组合式工作流 | 需求澄清、结构化开发、Git、探索和作者工具保持独立，可按任务组合 |
| 作者与评测工具链 | 仓库同时提供脚手架、确定性测试、materialization 校验和 Skill Eval / Review 工作流 |

如果只需要单个平台的一个原生 Skill，可以直接使用平台原生机制。当需要跨平台分发、项目级共享、可重复刷新同步与清理，或一组可以组合的能力时，AW 才提供额外价值。

## 快速开始

需要 **Node.js 22 或更高版本**。

```bash
npm install -g @lesliechan721/aw
aw init
aw
```

`aw` 会打开交互式插件管理界面。也可以直接使用命令：

```bash
aw install decision-kit --scope user --target codex --target claude-code
aw install dev-workflow --scope user --target codex --target claude-code
aw install git-toolkit --scope user --target codex --target claude-code
aw status --scope user
```

- `--scope user|project`：恢复命令必须显式选择个人或当前项目。
- `--target codex|claude-code|cursor`：选择本次 Agent，可重复；不保存为偏好。
- `--json`：输出适合脚本消费的结构化结果。
- `--verbose`：在 stderr 展开诊断。
- `--debug --log-file <path>`：把 Review、原生 Agent CLI 和写入阶段的结构化耗时写入指定调试日志。

## 选择插件

### 日常 Agent 能力

| 插件 | 适合什么场景 | 平台 |
| --- | --- | --- |
| [`decision-kit`](plugins/decision-kit/) | 澄清关键歧义、逐轮推演重要决定，制作决策原型，并维护项目领域词汇与重要决定 | Codex / Claude Code |
| [`dev-workflow`](plugins/dev-workflow/) | 独立完成设计或组织完整开发交付，组合 `decision-kit`、`human-content`、项目规范、实施与双轴 Review | Codex / Claude Code |
| [`human-content`](plugins/human-content/) | 解释已有复杂材料，提供保留原意、状态和完整来源的文字、图表或交互阅读页 | Codex / Claude Code |
| [`frontend-design`](plugins/frontend-design/) | 按网页用途选择视觉方向，设计与改进布局、排版、响应式和交互细节，保留已有系统约束 | Codex / Claude Code |
| [`git-toolkit`](plugins/git-toolkit/) | 创建精确本地提交、隔离 worktree，或协调 merge 双方意图 | Codex / Claude Code |
| [`agent-subagent`](plugins/agent-subagent/) | 使用 `spawn-subagent` 选择通用委派配置并管理外部执行 | Codex / Claude Code |
| [`codex-enhance`](plugins/codex-enhance/) | 在 Codex 中组织技术咨询和大范围只读探索；依赖 `agent-subagent` | Codex |

### Agent 内容、Skill 与插件作者工具

| 插件 | 适合什么场景 | 平台 |
| --- | --- | --- |
| [`agent-content-toolkit`](plugins/agent-content-toolkit/) | 编写、整理或只读评审 AGENTS.md、prompt、role instructions 和 references 等 Agent-facing 内容 | Codex / Claude Code |
| [`agent-skill-toolkit`](plugins/agent-skill-toolkit/) | 创建 Agent Skill、设计与审核 Eval；由用户启动单体、工作流和公开能力评审或简化；依赖 `agent-content-toolkit` | Codex / Claude Code |
| [`aw-development-toolkit`](plugins/aw-development-toolkit/) | 创建或维护 AW Catalog 与 Plugin Source，提供来源、物化和领域工具；Catalog 发布只由手动入口执行 | Codex / Claude Code |
| [`aw-skill-eval-runner`](plugins/aw-skill-eval-runner/) | 准备、独立审核并按授权执行 AW Skill Eval，验证结果并按需归因异常 | Codex / Claude Code |

## 使用示例

### 在实现前问清关键需求

```text
给团队邀请增加有效期。先帮我确认哪些行为必须由我决定。
```

`decision-kit` 会先调查现有代码和约定，只询问会明显改变结果、范围或验收的问题。

### 用原型帮助作出决定

```text
这个审批页面怎么排版我说不清。做一个可点击原型让我试，再记录我确认的决定。
```

`decision-prototype` 会制作回答单一问题的轻量原型。原型默认可丢弃，确认后的决定可以继续交给 Spec 或其它工作流。

### 启动结构化开发流程

```text
/dev 为团队邀请增加 7 天有效期。这个任务需要跨会话继续。
```

`dev-workflow` 会选择当前最小能力：设计由 `dev-design` 协调，实施与核验由 `dev-build` 协调，必要时组合 `decision-kit` 补充决定或制作原型。只需要设计时可直接请求 `dev-design`，不自动开始实施；明确的小任务仍然走快速实现路径。项目规范按主题维护，过程资料默认仅保存在本地 `.dev-workflows/`。

### 创建一个只包含本次改动的提交

```text
$git-commit 把刚才修改的三个文件提交，使用仓库现有提交规范。
```

`git-commit` 由用户手动调用，会保护范围外的 index 和 worktree 状态，创建并验证本地提交；它不会 push，也不默认追加测试、构建或代码评审。用户或仓库明确要求的提交门禁和 Git hooks 仍会执行。

### 探索陌生代码库

```text
调查鉴权失败的可能路径，只收集证据，不修改代码。
```

`codex-explore` 可以把大范围只读调查交给专用探索角色，最终判断仍由主代理完成。

### 编写或评审 Agent 内容与 Skill

```text
为这项重复工作设计一个 Agent Skill，并准备可验证的触发用例。
```

`agent-content` 处理 Agent-facing 正文。`agent-skill-toolkit` 在此基础上提供 Skill 作者、评审、简化、Eval 用例设计与独立审核，以及跨 Skill 架构评审。AW 格式的 Eval 准备、执行和结果验证由 `aw-skill-eval-runner` 负责。

## Skill 如何触发

每个 Skill 都声明自己的触发策略：

- **模型调用**：模型根据 Skill 的名称和描述判断是否适用。
- **用户显式调用**：适合授权敏感或明确改变流程的能力。
- **Slash Command**：为常用宏流程提供稳定入口；复杂逻辑仍保存在 Skill 中。

`git-commit`、`review-agent-skill`、`simplify-agent-skill` 和 `publish-aw-catalog` 由用户显式启动；Author 的日常自检不自动启动专项评审。Codex 使用 `$skill-name`，Claude Code 使用对应插件的 `/plugin-name:skill-name`。

AW 在安装时保留 Codex 和 Claude Code 的原生调用元数据，不使用 CLI 配置覆盖 Skill 的触发策略。

## 常用 CLI

```bash
# 同步来源，建立或更新 Active Catalog snapshot
aw catalog source sync official
aw catalog source sync official --yes
aw catalog source sync official --check
aw catalog source sync official --replace-damaged --yes
aw catalog source status official

# 检查或手工回收 immutable Catalog store；prune 默认只预览
aw catalog store status
aw catalog store prune
aw catalog store prune --yes

# 安装、刷新同步或移除
aw install git-toolkit --scope user --target codex --target claude-code
aw sync official/git-toolkit --scope user --target codex --target claude-code --refresh
aw uninstall official/git-toolkit --scope user --target codex

# 停用已从健康 Active Catalog 移除的插件；配置删除须明确选择
aw intent retire <source>/<plugin> --scope user --target codex --yes
aw intent retire <source>/<plugin> --scope project --delete-config --yes

# 在项目中声明插件，本机选择 Agent，然后恢复全部项目需求
aw intent add official/git-toolkit --scope project
aw targets set codex --scope project
aw status --scope project --json
aw sync --all --scope project
# 只在本次恢复中使用 Cursor，不保存为本机偏好
aw sync --all --scope project --target cursor
# 声明编辑不自动删除已有输出
aw intent remove official/git-toolkit --scope project

# 查看现场状态与只读恢复检查
aw status --scope user
aw sync --all --scope user --check

# 只读取得当前 Workspace 或单插件的 Review 证据
aw review inspect . --json
aw review inspect ./plugins/decision-kit --json

# 声明项目需求并尝试恢复；恢复失败时已提交的需求仍保留
aw install decision-kit --scope project --target codex

# 先导出并检查一个声明了 Portable 能力的合成本地 Catalog 插件
aw skill materialize <source>/<plugin> --scope project --out ./.aw-review/<plugin>

# Review 完整依赖闭包后，通过 PATH 中的兼容 Skills CLI 安装
aw skill install <source>/<plugin> --scope project

# 清理可证明归属的本地输出，保留普通项目需求与配置
aw cleanup official/git-toolkit --scope project --target codex
aw reinstall official/git-toolkit --scope user --target codex
```

普通 `uninstall`、`cleanup` 与 `cleanup --force` 只处理所选 scope 和 Agent 中可证明归属的现场，不修改声明、偏好或插件配置。来源或 Active 不可用时，有充分 live 或离线证据的清理仍可执行；foreign 和 shared 内容保留。`aw intent remove` 只编辑所选 scope 的声明，不删除已有输出。已移除插件使用独立的 `aw intent retire`；它要求健康 Active 中精确插件缺席，仅修改指定 scope，配置删除默认关闭。共享原生包无法安全移除或 Portable 有残留时会报告未完成目标。

`aw review inspect` 读取源码、已有 snapshot 和显式提供的物化来源 receipt，不执行被审插件代码。缺少当前物化产物时仍返回源码事实和证据缺口；该命令不作质量评价或发布决定。Eval prepare 和 Skill materialize 返回的 `sourceBindingPath` 可通过 `--materialization <receipt>` 交给检查命令，旧产物缺少该证据时重新准备即可。

project 配置按 Catalog logical identity 共享，不绑定 Git URL、SSH/HTTPS transport 或本地 path。若 Git 无法验证配置路径可提交，命令仍写入并返回 `projectConfigShareabilityUnverified`；若路径明确被 ignore，则以 `projectConfigIgnored` 停止且不修改配置。`aw config reset` 不受该检查阻止。

普通 install、reinstall、uninstall、status、config、TUI 初始 load 和 Portable 操作只读取本地 Active Catalog snapshot。显式 `sync --refresh` 和 TUI“刷新并同步”会先刷新相关来源，再基于新的 Active 建立 Review。User 与 Project 恢复中，某来源刷新失败即使旧 Active 仍健康，该来源的本次请求也保留 blocker 且不执行；其它已授权且独立的来源可以继续。没有 Active 时，CLI 提示 `aw catalog source sync <id>`。Active store 损坏时，Git source 先按 Active 的精确 commit 修复旧 store key；CLI 修复后继续检查当前候选，TUI 修复成功后停止并重新显示当前更新。精确旧版本无法取得，或 Path 当前内容不是旧 key 时，CLI 只接受 `aw catalog source sync <id> --replace-damaged --yes`，TUI 使用独立的“使用当前候选替换损坏的 Active” Review。`catalog-sources.json` 损坏时，TUI 可经 Review 备份原文件并恢复官方默认来源；它不删除 Catalog state 或 store。TUI 初始页面不等待网络；进入 ready 后，每个 session 只对开启自动检查的来源检查一次 freshness，并优先检查主来源。关闭后只能在来源详情手动检查。自动检查和“重新检查”先轻量检查健康 Git Active 的远端 ref；commit 未变时不 fetch，固定 commit 不联网；“完整验证”强制完整 resolve。没有 Active、Active 损坏和恢复动作仍完整验证，Path source 也完整验证本地候选。检查只更新当前 TUI 的提示，不修改恢复状态或 Active，也不会自动激活候选。完整背景 candidate 只可在绑定相同 session token、source config fingerprint 和 Active store key 时复用于普通 Review preparation；Execute 仍重新 resolve。候选缺少当前 AW capability 时显示 missing IDs，旧 Active 保持可用，普通 update 不出现。网络检查失败时，旧 Active 保持可用，用户仍可浏览。Git 完整 resolve 默认 timeout 是 180000 ms；ref probe 最多 30000 ms；`AW_CATALOG_REMOTE_TIMEOUT_MS` 接受 `0` 或 `100..300000`，其中 `0` 表示无 deadline。Catalog 更新在影响现有引用或影响未知时需要 `--yes` 或 TUI 明确确认；成功切换 Active 后，已安装插件不会自动升级，TUI 只重新计算可用的插件升级。普通 `cleanup` 不进行已移除插件分类；来源或 Active 不可用时，仍凭 live ownership 或离线 evidence 清理 AW-owned 输出。`cleanup --force` 可把当前 Active 中所选 plugin bundle 的 shallow evidence 作为可选补充。source、Active 或 Catalog store 缺失或损坏不能永久阻止独立的 `intent remove`，或阻止已有充分 live evidence 的清理；两者仍保留 foreign、shared 和 native payload，且不能猜测输出路径。CLI 的 `catalog source add` 和 `update` 只改 config；`add --primary` 在主来源切换有引用或 inventory 不完整时需要 `--yes`，移除有引用或引用清单不完整的 source 也需要 `--yes`。TUI add/update 先汇总完整草稿，再明确选择只保存配置或保存并启用已确认候选。`aw catalog source sync <id> --check` fetch 并验证来源候选，但不写 store 或 Active，并在 JSON receipt 中返回脱敏的影响证据；`aw catalog source sync <id>` 原子写 store 后切换 Active，失败时保留原 Active。Git 普通更新只接受更高版本；同版本不同 digest 和版本回退会停止。明确修改 URL、path、subdir 或 ref 后的 sync 可经确认切换。Path source 允许内容变化。

`aw catalog store status [--json]` 只读检查 immutable store。`aw catalog store prune` 默认是 dry-run；只有 `--yes` 才删除，且 `--dry-run` 与 `--yes` 互斥。只有仍在 source config 中的 source 所引用的 Active pointer 受保护；已删除 source 的 pointer 是 orphan，并按普通 inactive entry 的 30 天 retention 处理。若同一 store key 也被其它已配置 source 的 Active 使用，则 active 优先且继续受保护。健康的非 Active 正式 entry 只有超过 30 天才可回收；`.staging-*` 和 `.replacement-*` 超过 24 小时才可回收；`.quarantine-*` 还要求对应正式 entry 存在并通过完整验证。损坏、未知、unsafe、符号链接和 foreign node 都保留。实际 prune 在 AW_HOME mutation lock 内重新读取 state 和 store；state 损坏时零删除。单项删除失败不阻止其它安全项，并返回 partial receipt。这里没有自动 GC；误删的弱 snapshot 通过 source sync 重建，受保护的 Active、foreign 内容和无法证明安全的 residue 不由 prune 删除。

除 `cleanup` 和 `cleanup --force` 外，普通写操作在锁内复用一次 ordinary live inventory，并只对依赖计划中的目标执行 ownership、native、config 和 Active snapshot 重验。删除保护需要历史 project consumer 时，会使用独立范围的 inventory。需要定位耗时时，使用 `--debug --log-file <path>`，查看 `review.prepare.*`、`native:success|error` 和 `rebuild:action` 的 `durationMs`。原生事件只包含 agent、稳定 operation、退出状态和固定 reason，不包含 args、cwd、stdout、stderr 或未知错误文本。原生 CLI 时间单独记录，不计入 Catalog 读取时间。

`install`、`reinstall`、`uninstall`、`cleanup` 和 `sync` 都接受 `--allow-managed-codex-install`。只有计划实际需要写入、替换或移除 Codex shared native package，且 system Codex CLI 缺失、AW-managed cache 也不可用时，AW 才需要获取固定的 `@openai/codex@0.151.0` runtime。直接 TTY 会在首次获取或安全重建前询问一次，默认不允许；JSON 和非交互模式必须显式传该 flag。有效 cache 可直接复用，不再次询问。PATH 中已有但过旧、版本不可解析或探测失败的 system CLI 会停止操作，不能用 managed runtime 绕过。

该 runtime 位于 `AW_HOME` 的可删除弱缓存中，不加入 `PATH`，也不检测 Codex App。只修改已有 shared native 的 project activation 时不需要 manager；项目 intent 缺少 shared native package 时仍需要兼容的 system 或 AW-managed CLI。cleanup 和 uninstall 在没有可证明的 AW-owned native residue 时不会探测、提示或下载；移除失败会保留 residue，用户可重试命令、升级 AW，或安装兼容的官方 Codex CLI 后恢复。AW 不直接删除 Codex 私有 plugin storage，也不删除 foreign 内容。

### 托管命令

插件脚本和用户工具共用 `aw command run <command-id> -- <args...>` 稳定入口，升级资源路径不会改变同一 producer 的 ID。查看及维护用户工具：

```bash
aw command install ./review-adapter --name review-adapter --runner node --entry adapter.mjs
aw command list --json
aw command show <command-id> --json
aw command run <command-id> -- --region example
aw command update <cmdu-id> --from ./review-adapter --yes
aw command remove <cmdu-id> --yes
```

install 复制完整运行目录；原开发目录移动后，已安装工具继续可用。update 保留用户 ID，remove 后重新 install 使用新 ID。run 原样传递 argv 和 stdio，不接受 runner/env/cwd 临时覆盖，不隐式下载或安装。独立插件包由 `aw command package sync/remove` 显式维护；平台卸载保留共享包，并报告精确移除入口。完整字段、权限、所有权及恢复见 [托管命令合同](docs/managed-commands.md)。

Codex/Claude 静态原生 Skill 的命令共用 user 身份与配置；在项目中启用插件仍引用同一命令 ID。Claude 保留原生安装方式，项目配置不会覆盖共享启动定义。AW-owned 动态 Skill 则使用其实际 user/project 作用域。

### User 与 Project 插件恢复

Codex native plugin 和 project activation 统一要求最低版本 `0.151.0`。AW-managed runtime 固定为已 qualification 的 `0.151.0`。PATH 中没有 system CLI 且操作只需修改 project activation 时，AW 不下载 manager。此时 AW 未观察到 system loader 或 Codex App，只把 project activation support 标为 `assumed`。

User 与 Project 分别保存相同格式的 Intent v3。个人声明位于 `<AW_HOME>/plugin-intents.json`；项目声明位于仓库根的 `.agent-workflows/plugin-intents.json`。声明只保存 source-qualified 插件根和 Catalog logical identity，不保存 Agent、配置或安装现场：

```json
{
  "schemaVersion": 3,
  "kind": "aw-plugin-intents",
  "sources": { "official": { "logicalIdentity": "<Catalog logical identity>" } },
  "roots": [{ "pluginId": "official/decision-kit" }]
}
```

两份本机部署偏好分别位于 `<AW_HOME>/deployment-preferences.json` 和 `<AW_HOME>/project-preferences/<project-key>.json`，使用 `aw-deployment-preferences` kind。`aw targets set codex claude-code --scope user` 只保存 Agent；`aw targets reset --scope user` 清空 Agent 和 dependency placement override，不删除需求或安装。`aw intent add` 只读取健康本地 Active 并保存 root；`aw intent remove` 离线删除精确 root。普通 sync/reinstall/uninstall/cleanup 都不修改两份声明或偏好。`aw install` 先保存当前 scope 的需求，再尝试安装；安装失败不撤销成功的声明。没有目标时需求仍保留，需先设置 Agent 或用本次 `--target`。User 恢复不读取调用目录的项目配置或需求；Project 只针对当前 canonical 项目。旧 User v2 文件和旧 Project 偏好 kind 不自动迁移，应按精确文件备份后显式重建。

恢复命令 `intent`、`targets`、`install`、`sync`、`reinstall`、`uninstall`、`cleanup` 和 `status` 都要求显式 `--scope user|project`。`--target` 可重复，支持 `codex`、`claude-code`、`cursor`；不再接受 `aw project`、`-p/--platform` 或 `both`。`sync --all` 只选择当前 scope 的全部 root；`sync --all --scope user --check` 只读检查，不刷新来源、不安装，未满足或未知时退出 1。作者、config 和一次性 `aw skill` 命令的原有 platform 参数不受影响。

Native 适用时优先；只有无适用 Native 且 Manifest 明确提供 Portable 时使用 Portable。Native 工具或执行失败不自动降级。Codex static Skill、MCP、Hook 和 App 共用一份 user-level native package；Project 只控制当前项目 activation，不制造 User root。替换 shared native 时 Review 会显示其它消费者的影响。只选择部分 root 或 Agent 不授权删除其它已观察输出，未知的其它项目需求也不能当作无人使用。Codex 项目 activation 的最低 CLI 版本为 `0.151.0`；AW-managed runtime 固定该已资格验证版本。pure-native 的 User/Project 重叠允许；含 AW-only extension 的冲突会明确阻断。

`aw status --scope ... --json` 返回 `aw-recovery-status` schema 1，包含当前 scope 的 intent、目标选择、inventory、额外观察、覆盖和 `allSatisfied`。合法空需求为 true，明确缺失为 false，仅未知或未选目标为 null；`ok` 只表示观察是否出错。写命令返回 `aw-recovery` schema 1，分别记录声明、偏好、配置、输出变化事实和每个目标的执行、观察、内容状态。只读状态不运行 renderer、preApply 或来源刷新，也不创建持久 runtime、generation、lock 或目标目录。旧 Status v8、Native Receipt v6 和 ProjectRecovery v1 不再是这些命令的公开恢复输出。

TUI 首页以“插件清单”进入个人或当前项目范围；同一清单和详情按 scope 隔离搜索、筛选、多选及草稿。目标编辑只保存偏好，“立即同步”创建新的 Review。根状态按受阻、未确认、待同步、就绪分类；已移除插件使用独立停用任务。来源草稿仍明确选择只保存或保存并启用。`h` 返回首页，`H` 安全重载会话。界面入口与操作覆盖见 [CLI/TUI 能力覆盖](docs/tui-capability-coverage.md)。

普通一次性 `aw skill install` 和 `aw skill materialize` 仍显式选择 scope，并遵守各自既有 Agent 与 provider 兼容合同；它们的 receipt 不合并进统一恢复回执。统一 Portable 恢复固定使用 `skills@1.5.23`、明确 Agent、copy 模式和精确 Skill 集合。Project 使用项目根，User 使用经过祖先链核验的中性 cwd 和 global 模式；AW 写前独立检查对应 provider lock。真实 Darwin arm64 资格报告证明该版本的三个 Agent 在隔离 global add/list 下的目录与清单行为；global local add 不写 lock，list 的 source 为 null，损坏 lock 仍可能退出 0，所以 AW 不能把 provider 退出码当作安全证据。User Portable 的缺失目标可安装，同内容的现有目标只算 external satisfied；异内容因来源未知而阻断自动覆盖，须精确手动移除后再 sync。AW 不借历史 generation 推断归属，也不增加账本或 marker。Project 只有在可靠 provider source 关联和旧树完整匹配时才可按 drifted 规则更新。跨平台路径按固定 provider 的正式环境变量与平台用户目录解析；路径不安全或目标无法对齐时阻断。Linux、Windows 和 macOS x64 不因缺少实测报告而禁用；这些环境的实测证据仍待补。

该 provider 会过滤任意层级的 `metadata.json` 文件和 `.git`、`__pycache__`、`__pypackages__` 目录；候选含这些内容时，AW 在写入前返回 `portableProviderContentUnsupported`。Codex 和 Cursor 共用 `.agents/skills` canonical 根；Claude 使用独立的 Claude config 目录。Portable 自动安全卸载仍无合同，两个 scope 的 uninstall/cleanup 都报告具体残留检查指引。真实 Agent 加载证据与 provider 文件复制是不同资格：Darwin arm64 上 Codex CLI `0.151.0` 的 Project Native 报告通过；Claude Code `2.1.119` 的实际 Skill 加载、Cursor binary、Windows 与其它 OS 的相应行为仍未验证。

## 配置子代理

```bash
aw config list agent-subagent -s user
aw config set agent-subagent generalTaskProfile -s user --value-json '{"executor":"native"}'
aw config set codex-enhance standardProfile -s user --value-json '{"model":"gpt-6-luna","reasoningEffort":"high"}'
aw config set codex-enhance advisorGeneralProfile -s user --value-json '{"model":"gpt-6-astra","reasoningEffort":"high"}'
```

`agent-subagent` 提供通用四档和自定义档位，四档默认只设置 `executor: native`，不覆盖当前宿主模型或推理强度。Advisor 和 Explore 的专用档位仍在 `codex-enhance`，默认模型和强度保持。两插件的外部 executor key 都从同 source 的 `agent-subagent.subagentCommands` 选择，先保存注册项，再设置消费方。外部 profile 可省略 model/reasoningEffort，表示后端默认。共用配置只在 user 层编辑，包括 Claude project 安装。保存不改变安装产物，`--apply --yes` 才更新当前目录可见的受影响目标；原生宿主可能需要刷新或新会话。

外部执行器可选 Codex、Claude Code、Oracle、Antigravity、绝对入口 custom，或引用稳定 commandId 的 custom-managed；自定义接入使用 Adapter v5。任务和消息只接受文本或直接文件参数，不从 -/stdin 读取。result 支持普通报告和 `--output-file PATH`，完整写入并关闭新文件后消费；--export 返回参数错误。bundle 通过 --file 选择材料，workspace 在任务正文中说明关注路径。

跨插件候选需要支持 `aw.plugin-config-cross-plugin-value-ref.v1` 的 CLI/Core，先升级工具，再分发插件。切换前结束旧 Guide 任务并保存所需结果，再显式配置新插件；不提供旧入口、配置迁移或旧 run 接续。旧字段可用 unset/reset 删除，旧 AW-owned 输出用 sync/reinstall/cleanup 恢复。具体配置、权限和边界见 [Agent Subagent README](plugins/agent-subagent/README.md) 和 [Codex Enhance README](plugins/codex-enhance/README.md)。

## 安装范围

- **User scope**：为当前用户安装，适合跨项目复用。
- **Project scope**：仓库共享无平台的插件需求；本机选择 Agent 后，AW 按适用 Native 或 Portable 交付恢复。Codex activation、Claude 输出和 AW-only extension 仍按各自平台合同写入。

Codex project scope 不复制 static Skill、MCP、Hook、App 或其它 native plugin payload。它只在 `.codex/config.toml` 写 activation，并按需在 `.agents/skills`、`.codex/config.toml`、`.codex/rules/` 和 `.codex/agents/` 写 AW-only 动态或配置派生产物。AW owner marker 限定后续清理范围。

## 对安全边界的约定

- 插件不会因为安装而自动获得超出宿主平台的权限。
- 需要用户授权的写操作仍由当前会话、仓库政策和 Skill 本身约束。
- `git` 插件不执行 push。
- `codex-explore` 是行为只读的证据探索能力，不把最终判断或产品写入交给探索子代理。
- 作者和评审能力分离：Reviewer 不修改被审生产源码，Author 不给自己的结果生成独立发布结论。

## 本地开发与发版流程

### 第三方 Catalog 与 Plugin 作者

第三方作者只需要 Node.js 22+ 和已安装的 `aw` CLI，不需要 clone 本仓库、`pnpm` monorepo 或官方 release 脚本。安装 `aw-development-toolkit` 会解析完整作者工具依赖：

```bash
aw install aw-development-toolkit --scope user --target codex --target claude-code
```

涉及 AW 插件及其 Skill 的分析、创建、修改、评审协作、简化协作、验证和物化时采用 `develop-aw`，按本次结果选择源码或实际产物；也用它维护 Workspace 和 canonical Plugin Source。删除先检查 Workspace、插件名、inventory 和反向依赖，再使用公开 `aw plugin remove`；receipt 返回后检查剩余 inventory，空 inventory 不检查已删除对象。删除不会自动 publish。专项评审由用户显式启动 `review-agent-skill`；完整审核先复用匹配的 final，不足时说明 build/renderer 与隔离输出后运行 `aw review prepare`，再针对实际产物判断。标准 Agent Skills 导出另需显式 Portable 声明和 `aw skill materialize`；不把它设为普通源码分析或原生包审核的前提。用户明确禁止执行时只做限定的源码审核。远端发布只由手动调用的 `publish-aw-catalog` 执行，并只在用户授权完整 `planDigest` 后 apply。Workspace、聚合验证、publish plan/apply、失败恢复见[Catalog 作者指南](docs/catalog-authoring.md)；manifest、单插件命令和 Plugin Source 边界见[插件作者指南](docs/plugin-authoring.md)。

当前作者合同固定为 Plugin Manifest v3、Catalog snapshot schema 7 和 Catalog Sources Config schema 2。Agent 作者入口先运行 `aw self check --from <skill-root> --json`，并以 capability receipt 判断兼容性；不使用 CLI version gate。每个 Catalog 命令自行定位 Workspace；静态 `aw catalog status --json` 不 build 或 fetch。Development source 使用 `aw catalog dev activate|status|deactivate --json` 管理；activate 会 build、validate、注册 managed Path source 并 sync。activate 影响现有引用或影响未知时使用 `--yes`；deactivate 检测到 installation、lifecycle、config 或 marketplace 引用，或 inventory 不完整时也使用 `--yes`，其 schema 4 receipt 返回脱敏的 inventory v2 `impact`。

远端 Catalog 发布先运行 `aw catalog publish plan`，确认 Workspace identity、source HEAD、remote identity、branch、parent、tag、snapshot digest、`expectedCommit` 和 `planDigest`。`planDigest` 绑定 canonical `{ descriptor, expectedCommit }`。确认后再使用 `aw catalog publish apply --expected-plan-digest <digest> --yes`。apply 用 digest 唯一定位 schema v2 `.aw/publish/<version>/journal.json`，不依赖当前 metadata version。相同 plan 可在当前 HEAD 或 dirty state 改变后对账或续跑；Workspace identity、remote identity 和 branch 仍必须相同。不同 plan 必须提高 Catalog version。

Skill-local Eval 作者合同使用 Manifest v1。profile 的 `plugins` 提供公共非敏感配置；可选 `configByScope.user/project` 为已选插件提供顶层字段覆盖。`aw skill eval prepare` 按 plugin、Skill、suite、profile 和 case 选择，以隔离配置物化静态、动态和共享 Codex native Skill，并生成输入完整的 `EvalSpec v1`，但不安装插件或运行模型。`@lesliechan721/agent-skill-eval` 是 `EvalSpec v1 → EvalAudit v1 → EvalResult v2` 的唯一机器 owner；Result v2 要求 `processManagement` 证据，不兼容 Result v1。执行前必须有精确绑定 provider、workspace、current/optional previous target、case digest 和全部 selected cases 的 passing Audit，并运行 `aw-skill-eval run <spec.json> --audit <audit.json> [--allow-unmanaged-processes]`。所有真实 run 在 output 和模型前检查 permission、macOS Codex 可执行入口与 keychain，以及进程管理能力。默认 managed 模式要求 Full Access 语义和可用的进程树检查；单次提权不等于 Full Access。只有用户明确接受本次风险时，才可增加一次性的 unmanaged flag；该模式只尽力终止直接 child，不保证后代清理，也不能绕过 cmux Codex wrapper 或 keychain 检查。完整边界见[架构说明](docs/architecture.md)。普通成功路径不运行 `aw skill eval doctor --json` 或 `aw-skill-eval inspect-result <result.json> --spec <spec.json> --audit <audit.json>`。doctor 用于安装或升级、用户明确请求诊断，或模型已启动后的 run 失败；inspect-result 用于异常结果分组。执行或评分失败、current 混合、baseline 回归，或结果将驱动生产 Skill 修改时，执行独立 result-triage；其余 clean success 交付后结束。

Eval 准备可加 `--config-file <file>`，为已选插件提供本次非敏感配置覆盖，例如已安装 adapter 的绝对路径。实际输入保存在 source binding。workflow provider 可使用公共 instruction-v2 transport，以及有界的 fixture setup、交互和收尾动作；这些动作只建立真实前提或检查实际产物，模型执行与独立评分仍由 Eval Engine 管理。配置、协议和动作边界见[架构说明](docs/architecture.md#agent-skill-eval-执行与-runner-边界)。

### 本仓库维护与官方发版

本官方仓库本身也是普通 Catalog Workspace，使用与第三方相同的 marker、metadata、inventory、Core validator、publish plan/apply、publisher 和 publication journal 合同。以下 `pnpm` 命令只面向本 monorepo 维护者，用于编排 CLI/Core/npm/Product Release；它们不是第二套 Catalog contract：

Review 按当前请求在对话或指定文件中交付设计判断、findings 和未覆盖项。报告不构成插件发布门禁，也不自动更新 production README。

```bash
make install
make build
make test
```

日常开发可使用 `pnpm build:dev` 复用按目标划分的弱缓存；`pnpm test:dist:dev` 在该开发 build 后运行与正式 `test:dist` 相同的 dist contract 和 build smoke。正式交付和发布仍使用 `pnpm build`、`pnpm build:ensure` 与 release verification。

CLI 产品包含同版本的 Eval、Core、CLI 和两个 Windows Job 平台包。打包命令从同一候选生成五个 tarball；本地安装从这组产物解析全部自有依赖，并只安装适用平台包。平台包 EXE 随 npm 依赖安装，运行时不另行下载：

```bash
pnpm release:pack:cli
pnpm release:install:local
# 或使用已生成的完整五包：
pnpm release:install:local -- <cli.tgz> <eval.tgz> <core.tgz> <windows-x64.tgz> <windows-arm64.tgz>
```

`pnpm build` 对官方 Catalog source 使用 `--strict-requirements` 语义，并生成 `packages/cli/plugins-dist/` schema 7 本地 snapshot。`release:verify:catalog:core` 通过此官方 build 覆盖 strict 门禁。第三方公开 `aw catalog build` 默认只 advisory。Catalog staging 和本地 release prepared 文件都是生成状态，不手工修改。

Windows helper 的唯一 Go 源和固定工具链位于 `native-tools/windows-job/`，工具版本取自 CLI。普通开发 build/test 不取得真实 EXE，也不要求 Go；npm 安装不编译 Go，不运行下载或复制 EXE 的 postinstall。三个通用 npm 包、Skill 和 Catalog 不包含 EXE。显式原生准备和 CLI 发布打包会构建本次两架构平台包；本次候选需通过可复现检查及真实 Windows x64/arm64 资格。原生源码、工具链和生产逻辑变化属于 CLI 产品变化。作者声明、包解析和恢复见[原生工具合同](docs/native-tools.md)。

```sh
pnpm native:windows-job:prepare
pnpm native:windows-job:reproduce
# 在对应真实 Windows 架构运行，使用本次候选平台包：
pnpm qualification:windows-job
```

候选输出位于 `.native/windows-job/<CLI version>/`，包含两架构 EXE、平台 tarball 和构建、复现及资格证据。插件只声明宿主协议 `aw.windows-job.v1`，不保存工具版本或摘要；升级 CLI 配套工具无需重新发布或重装插件。

CLI 复用 Eval 从自身依赖解析适用平台包的能力，独立安装 Eval 也可运行。Windows 缺少 optional dependency 时，需要工具的操作在启动前失败；重新安装当前 CLI/Eval 并包含 optional dependencies。运行不访问 registry，不使用 AW 原生 cache、预取、离线 import 或原生 registry 配置。离线安装沿用包管理器缓存或预先准备的同版本完整依赖包。

Codex native qualification 是显式、本机、离线的维护者入口，不进入普通 test、build 或 release。现有 `0.151.0` project activation 行为使用 `pnpm qualification:codex-project-native`。性能和 scoped list 合同分别对本机已有的两个精确 binary 运行；命令不会自动下载：

```bash
CODEX_QUALIFICATION_VERSION=0.151.0 CODEX_QUALIFICATION_CLI=/path/to/codex-0.151.0 pnpm qualification:codex-native-performance
CODEX_QUALIFICATION_VERSION=0.153.0 CODEX_QUALIFICATION_CLI=/path/to/codex-0.153.0 pnpm qualification:codex-native-performance
```

每次运行只使用临时 home、临时项目和 local marketplace，并阻断 proxy。两个版本都必须支持 marketplace-scoped JSON list；`0.153.0` 的 local scoped list 不得依赖远程 Catalog。代表性 local native install 运行五次，中位数必须低于 15 秒；精确 binary 缺失时保留未运行缺口。该 qualification 不接入 app-server plugin/reconcile，也不证明运行中的 Codex App 会自动刷新。

官方发布使用 GitHub Actions。PR/main 自动运行 CI；main 的精确提交通过后，分别比较 CLI 五包的生产输入与 Catalog 的实际生产内容。有变化的产品自动准备 beta，版本提交和源码 tag 只放在 `release-source/<product>/<version>` 分支，main 不接收自动版本提交。默认稳定版后从下一 patch beta 开始；显式修改稳定目标可指定 major/minor。CLI 和 Catalog 各自保留成功结果；同批发布显式关联本次 CLI 候选，Catalog 远端写入等待 CLI 完成。

自动 beta 发布复用其精确 main 来源已通过的 CI 检查，不重复运行完整源码验证。源码 tag 记录 CI run/attempt，发布时重新查询并核对必要检查；证据缺失或查询失败时运行完整验证。候选构建、版本与产物校验、跨平台产物 smoke 仍必须通过。手动准备的候选和正式版继续运行完整验证。

正式版在 `Release CLI` 或 `Release Catalog` 的 Actions 页面选择 `source`，填写精确稳定版本和 main 提交 SHA。入口准备候选后推送 `release/cli/v<version>` 或 `release/catalog/v<version>`，触发该产品的验证与发布。也可在已有工具构建的干净 checkout 中运行以下维护命令；它会推送候选分支和 tag：

```bash
pnpm release:actions source --product cli --version 0.2.1 --source <main-sha>
pnpm release:actions source --product catalog --version 0.5.1 --source <main-sha>
```

每个候选只构建一次，六种 OS/CPU 的 Node 24 smoke 和精确 Node 22.0.0 最低版本 smoke 消费同一恢复包。Windows 两架构从本次平台包安装和运行 helper，不能只根据 npm 安装退出 0 判断可选依赖完整。任一门禁未通过就不发布。CLI 五包使用 npm Trusted Publisher；Catalog 消费原 snapshot/plan。原生 qualification 使用本次候选；Catalog 的 fake native runner 不表示真实 Codex/Claude 已通过 qualification。

首次启用需要以下仓库外部配置：

- GitHub App 的安装范围仅为本仓库，授予 Contents write；设置变量 `RELEASE_APP_ID` 和 secret `RELEASE_APP_PRIVATE_KEY`。未设置 `RELEASE_APP_ID` 时，main CI 仍执行全部验证，但跳过自动 beta 发布；配置 App 后启用自动发布。用 branch/tag ruleset 保护 main 和非发布 refs，App 不获得 main bypass。App token 本身不能按 ref 缩小权限；入口只推送规定的候选 refs。App 推送会触发 tag workflow，默认 GITHUB_TOKEN 不具有这一行为。见 [GitHub 触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
- 五个公开 npm 包分别配置 Trusted Publisher：当前仓库、`release-cli.yml`、environment `npm`；两个平台包也使用该实际发布工作流。发布 job 使用 GitHub-hosted Linux、Node 24、npm 11.6.2 和 OIDC，不需要长期 npm token。见 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
- 确认六种 hosted runner 可用于本仓库，并允许 30 天 artifact 保留期。可设置 repository variable `AW_TEST_WORKERS` 调整普通测试并发；串行和性能入口保持固定约束。

恢复包先于首次远端写入上传，按精确 run/artifact ID 与 digest 恢复；最终状态另存。CLI 部分成功时在 `Release CLI` 中选择 `repair-cli` 并填写原源码 tag；只缺完成 tag 使用 `repair-cli-tag`。Catalog 选择 `resume` 并填写原 tag，继续原 plan。普通 CLI 重跑不续传已尝试版本。恢复包缺失、损坏或超过 30 天保留期时使用新版本；不要删除占号 tag 或重建旧 plan。本地和 Actions 不同时操作同一候选。

本地一体维护入口继续可用。渠道必须是 `beta` 或 `release`，并显式选择 CLI、Catalog 或两者：

```bash
pnpm release -- beta --cli
pnpm release -- beta --catalog
pnpm release -- beta --all
pnpm release -- release --all
```

进入下一条稳定版本线时，在同一命令中指定 bump。`--plugin` 可按需重复：

```bash
pnpm release -- beta --cli --cli-bump patch
pnpm release -- beta --catalog --catalog-bump patch --plugin <plugin-name>=patch
pnpm release -- beta --all --cli-bump patch --catalog-bump patch --plugin <plugin-name>=patch
```

`release/version-targets.json` 只保存 schema 2 CLI stable target。Catalog 的唯一版本真值是 `plugins/marketplace-source.json.catalog.version`，并始终表示下一次精确 stable 或 `x.y.z-beta.N` beta。维护者也可以通过同一公开入口显式设置或提升它：

```bash
aw catalog version 0.2.0-beta.1 --workspace-root .
aw catalog version --bump patch --workspace-root .
```

产品源码必须先提交，且工作树必须干净。命令先选择 Catalog beta，再调用上述公共 version mutation；需要变化时创建一个精确只包含 `plugins/marketplace-source.json` 的 commit。CLI/plugin metadata 使用单独白名单 commit。没有 Catalog version 变化时不创建空 commit。随后运行所选轴的完整验证，在 gitignored 的 `.release/prepared/` 生成本地 artifact 和 plan，并按 `两个 Windows 平台包 → Eval → Core → CLI → cli-v<version> 完成 tag → Catalog` 发布。五包使用相同版本和渠道；任一已存在同版本包都占用候选版本。Catalog 轴最后调用与普通 Workspace 相同的 publisher；CLI tag 只推送到 `origin`，当前分支不自动推送。

五包 `npm publish` 全部成功后即写 CLI 完成 tag，并允许同批 Catalog 继续。普通发布不额外下载远端包作校验。完成 tag 不保证 npm 已传播完成，发布后立即安装仍可能需要等待。显式 CLI repair 仍核验已有远端包，以确认原候选已完整发布。

Catalog 工具链按本次发布场景固定，恢复包保存精确版本与完整五包 tarball，恢复不重新查询浮动标签：

| 场景 | 使用的 CLI 工具链 |
| --- | --- |
| 同源、同渠道的 CLI 与 Catalog 同批发布 | 本次完整五包 artifact；自有依赖全部从本地解析，Catalog 写入等待 CLI 完成 |
| 只发 beta Catalog | 准备时解析 npm `beta`，验证对应 beta CLI 已完成发布 |
| 只发正式 Catalog | 准备时解析 npm `latest`，验证对应无 prerelease 的 stable CLI 已完成发布 |

Catalog-only 不编译 Go。缺少可用渠道 CLI、五包不完整或能力不支持时，先发布对应渠道 CLI；不跨渠道回退，也不使用当前未发布的源码 CLI。所选 CLI 用于本次 Catalog 的 build、validate、物化 smoke 和 publisher；Catalog 内容仍来自本次源码。第三方直接使用 `aw catalog` 时使用当前安装的兼容 CLI。Catalog 元数据不永久绑定工具版本。

本地已有待恢复的 Catalog plan 时，使用原渠道的 `pnpm release <beta|release> --catalog` 续跑。命令核验原 prepared descriptor、五包和 journal，并使用原工具验证同一 plan，不再查询浮动标签。若同批 CLI 尚未完成，先用 `--repair-cli` 或 `--repair-cli-tag` 修复 CLI，再恢复 Catalog；完成检查失败会保留原 CLI repair 材料。恢复材料缺失或损坏时须提升 Catalog version。若要同时发布新 CLI 或修改插件，先提升 Catalog version，再使用 `--all` 或 `--plugin` 创建新候选。

本地 Catalog 候选号继续读取 source metadata、`catalog-v` tag 和 publication journal，已占用 beta 使用新序号。官方插件版本由 Core 统一分配，合并 latest/beta 的完整成功历史，未变化插件复用完整版本；稳定插件变化自动推进自身 patch，已有 beta base 内递增，显式较高 base 开新线。删除重加继续使用历史；同版本不同内容拒绝。第三方 publisher 未提供官方历史时保持其原 channel 历史行为。Catalog-only 不发布 npm package，也不创建 CLI tag 或 `.release/attempted.json`。

远端 npm 发布失败或结果不确定后，不要直接重试单个 `npm publish`，也不要删除 `.release/attempted.json`。beta CLI 的普通恢复是用相同轴重新运行 `pnpm release`；工具保留稳定 target，自动选择下一个 beta，并重新准备和发布五包整组。稳定 CLI 仍需指定 `--cli-bump`。若要补发原候选中确认缺失的包，保留 prepared state 并运行 `pnpm release -- --repair-cli`；命令绑定未变化的 descriptor 和 attempt，核验 source、artifact 和 registry 中已存在的包，只补缺失包，最后核验五包并补 CLI 完成 tag。若五包已完整发布而只缺 tag，可运行 `pnpm release -- --repair-cli-tag`。没有独立的原生工具 repair。Catalog 使用 schema v2 `.aw/publish/<version>/journal.json` 和 pending `repository/`。相同 journal plan 可对账或续跑，不同 plan 必须提升 Catalog version。`prepared` 或 `uncertain` 的 journal 或 repo 缺失或损坏时，停止并提升版本，不盲目重建或复用。`published` journal 缺失时，远端 immutable tag 仍占用版本。成功时先保存 published journal，再尽力删除 repo；清理失败只报告 warning。CLI 成功而 Catalog 失败时保留 CLI 成功；CLI 失败时不发布依赖它的 Catalog。

CLI 读取 Catalog Sources Config schema 2 的 Git/path sources。默认 `official` URL 是 `https://github.com/lesliechan721-arch/agent-workflow.git`；release 使用 `refs/heads/catalog/latest`，beta 使用 `refs/heads/catalog/beta`。当前 Catalog Workspace 的本地 development source 使用 `aw catalog dev activate|status|deactivate --json` 管理；有影响或 inventory 不完整的 deactivate 需要 `--yes`，并返回 schema 4 的脱敏 `impact`。

维护者入口：

- [架构说明](docs/architecture.md)
- [编码约定](docs/coding-conventions.md)
- [测试指南](docs/testing.md)
- [Catalog 作者指南](docs/catalog-authoring.md)
- [Plugin 作者指南](docs/plugin-authoring.md)
- [插件维护指南](docs/plugin-maintenance.md)
- [插件与 Skill README 规范](docs/readme-standard.md)
- [Agent 项目指令](AGENTS.md)

插件源码位于 `plugins/`。`packages/cli/plugins-dist/`、`packages/cli/dist/`、`.release/` 和本机 `~/.aw/` 都是生成或运行目录，不手工维护。
