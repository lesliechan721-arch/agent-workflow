# Codex Repo-Managed Artifacts 方案

> 历史文档
> 适用背景：本文记录的是 Codex repo-managed artifacts 的独立探索稿，成稿时尚未完全并入 `embedded plugins root + ~/.aw` 的最终模型。
> 失效说明：文中涉及 repo marketplace、源码树平台 manifest 和旧版 instructions 落点的表述不再代表当前推荐做法。
> 当前方案：请以 [docs/dev/plans/npm-plugin-marketplace-new.md](npm-plugin-marketplace-new.md) 和 [docs/dev/todos/npm-plugin-marketplace-new.md](../todos/npm-plugin-marketplace-new.md) 为准。

## 目的

这份文档只解决一个问题：

- 在 `aw` 的后续实现里，怎样给 Codex 定义一套可落地的 `repo-managed artifacts` 模型

它不再讨论“Codex 是否支持原生 repo 级插件安装”这个问题，因为上游源码已经给出明确答案：**不支持**。本文的目标是把后续实现该写哪些文件、哪些状态应该留在 `CODEX_HOME`、哪些状态应该落在仓库里讲清楚，避免继续混用两套语义。

## 一句话模型

把它想成 npm：

- `repo-managed artifacts` 像 `package.json`、`pnpm-lock.yaml`、`.vscode/extensions.json`
- Codex 原生安装状态像 `node_modules`

前者跟仓库一起提交，后者属于用户本机状态。

放到 Codex 里也是同一个逻辑：

- 仓库里维护的是“声明、素材、项目级扩展”
- `CODEX_HOME` 里维护的是“原生 marketplace 注册、plugin enabled 状态、插件缓存”

## 设计边界

### 目标

- 给 `aw install/uninstall/upgrade/status --platform codex` 提供稳定的实现边界
- 明确 `user` 和 `project` 两个 scope 在 Codex 下分别代表什么
- 给后续测试设计一个统一的真值模型

### 非目标

- 不把 project `.codex/config.toml` 伪装成 Codex 原生 plugin install state
- 不把 `~/.codex/plugins/cache` 复制进仓库
- 不把 repo-local `CODEX_HOME` 当默认产品语义
- 不要求一条命令只触碰一个物理目录；允许“用户 scope 原生状态 + 项目 scope repo 产物”并存，但语义必须说清楚

## 核心原则

### 1. 原生状态和仓库产物分开建模

Codex 里至少有两条独立平面：

- 原生平面：`~/.codex/config.toml [marketplaces.*]`、`[plugins.*]`、`~/.codex/plugins/cache`
- 仓库平面：repo 下 `.agents/`、`.codex/`、`AGENTS.md`

它们可以在一次 `install --scope project` 中同时发生变化，但不能共用同一个“真值来源”。

### 2. `project` 只代表 repo 级产物，不代表原生安装范围

在 Codex 下：

- `--scope user`：原生状态和扩展产物都写用户目录
- `--scope project`：repo 级扩展产物写仓库；原生 plugin / marketplace 状态如有需要，仍写用户目录

也就是说，`project` 是“项目级效果”，不是“原生安装落点”。

### 3. 优先使用 Codex 已支持的原生落点

能走上游原生目录约定的地方，就不要发明新的伪约定。后续实现应优先使用这些路径：

- repo marketplace：`.agents/plugins/marketplace.json`
- repo skills：`.agents/skills/.../SKILL.md`
- project config layer：`.codex/config.toml`
- execpolicy：`.codex/rules/*.rules`
- hooks：`.codex/hooks.json`
- agent roles：`.codex/agents/*.toml`
- project docs：仓库层级的 `AGENTS.md`

### 4. 卸载默认只清自己这层

`project uninstall` 默认只移除 repo-managed artifacts，不自动删用户级原生插件状态。原因很简单：原生状态是共享的，可能已经被别的 repo 或用户级场景复用。

如果未来需要“连原生状态一起清”，应做成显式能力，例如：

- `--purge-native`
- 或单独的 `aw uninstall-native`

## 真值矩阵

| 关注点 | 推荐落点 | scope | 真值来源 | 说明 |
| --- | --- | --- | --- | --- |
| marketplace 注册 | `~/.codex/config.toml [marketplaces.*]` | user-only | 用户 config | project 不参与 |
| plugin enabled 状态 | `~/.codex/config.toml [plugins.*]` | user-only | 用户 config | project `.codex/config.toml` 不作为插件真值 |
| plugin cache | `~/.codex/plugins/cache/...` | user-only | 本地文件系统 | 不应复制进 repo |
| repo marketplace 声明 | `.agents/plugins/marketplace.json` | project | 仓库文件 | 用于 repo-local 发现 |
| repo skill | `.agents/skills/.../SKILL.md` | project | 仓库文件 | 适合 workflow / prompt scaffolding |
| project MCP 配置 | `.codex/config.toml` | project | 仓库文件 | 受 trust 影响 |
| execpolicy | `.codex/rules/*.rules` | project | 仓库文件 | 受 trust 影响 |
| hooks | `.codex/hooks.json` | project | 仓库文件 | 受 trust 影响 |
| agent roles | `.codex/agents/*.toml` | project | 仓库文件 | 受 trust 影响 |
| CLI tracking | 短期可放 `.codex/.agent-workflows-manifest.json` | project | CLI 私有记录 | 只追踪生成产物，不追踪原生安装真值 |

## 推荐目录布局

### 1. 市场源仓库布局

如果当前仓库本身要作为 Codex marketplace source，推荐长这样：

```text
repo/
├─ plugins/
│  └─ git-commit/
│     ├─ .codex-plugin/
│     │  └─ plugin.json
│     ├─ .claude-plugin/
│     │  └─ plugin.json
│     ├─ .mcp.json
│     └─ skills/
├─ .agents/
│  └─ plugins/
│     └─ marketplace.json
├─ docs/
└─ package files...
```

这里：

- `plugins/<name>/...` 是插件源码和市场素材
- `.agents/plugins/marketplace.json` 是 Codex 的 repo marketplace 入口

### 2. 消费 repo 在 `project` scope 安装后的目标布局

如果用户在某个业务仓库里执行：

```bash
aw install git-commit --platform codex --scope project
```

推荐目标布局是：

```text
consumer-repo/
├─ .agents/
│  └─ skills/
│     └─ aw-git-commit/
│        └─ SKILL.md
├─ .codex/
│  ├─ config.toml
│  ├─ hooks.json
│  ├─ rules/
│  │  └─ aw-git-commit.rules
│  ├─ agents/
│  │  └─ aw-git-commit-reviewer.toml
│  └─ .agent-workflows-manifest.json
└─ AGENTS.md
```

注意点：

- `AGENTS.md` 默认视为用户自己的项目文档，不建议 `aw` 自动改写
- 生成型内容优先落 `.agents/skills` 和 `.codex/*`
- 原生 plugin install state 不在这个 repo 里

## 能力映射

下表给出推荐的实现映射，不再把所有“扩展内容”都塞进 `.codex/AGENTS.md` 这类伪目标路径。

| 中立能力 | 推荐 Codex 落点 | 说明 |
| --- | --- | --- |
| 原生 plugin skills / mcpServers / apps | 走原生 plugin install 平面 | user-only，写 `~/.codex/config.toml` 和 plugin cache |
| 插件补充工作流说明、提示模板、操作习惯 | `.agents/skills/<generated>/SKILL.md` | 这是最接近“repo-managed instructions”的原生能力 |
| 项目级 MCP server 配置 | `.codex/config.toml [mcp_servers.*]` | 只在 trusted project 中生效 |
| 审批 / execpolicy 规则 | `.codex/rules/*.rules` | 只在 trusted project 中生效 |
| command hooks | `.codex/hooks.json` | 只做 Codex 稳定支持的 command hook |
| 项目 agent role | `.codex/agents/*.toml` | 使用 Codex 当前 agent role 文件格式 |
| 用户项目文档 | `AGENTS.md` | 默认不由 `aw` 生成或覆盖 |

### 关于 instructions 的推荐

后续实现里，`extensions.instructions` 不建议继续直接写 `.codex/AGENTS.md`。推荐优先级如下：

1. 优先转成 repo skill，落到 `.agents/skills`
2. 如果确实需要常驻 project config 文本，再评估写 `.codex/config.toml` 的 `instructions` 字段
3. 不再使用 `.codex/AGENTS.md` 作为目标路径

这样做的原因是：

- `.agents/skills` 是 Codex 真实支持的 repo 技能入口
- `AGENTS.md` 的原生发现路径是仓库层级，不是 `.codex/AGENTS.md`
- 自动改写用户根目录 `AGENTS.md` 侵入性太强

## 命令语义

### `install`

### `aw install <plugin> --platform codex --scope user`

行为分两部分：

1. 写原生状态到 `~/.codex/config.toml`
2. 如插件声明了用户级扩展产物，再写到 `~/.codex/`

这是最纯粹的 user scope。

### `aw install <plugin> --platform codex --scope project`

推荐行为也分两部分：

1. 原生平面
   - 如插件需要走 Codex 原生 plugin 能力，仍确保 `~/.codex/config.toml` 里存在 marketplace 和 plugin enabled 状态
   - CLI 必须显式提示用户：这一步写的是共享 user state，不是 repo-local state
2. 仓库平面
   - 把 repo-managed artifacts 写入当前仓库的 `.agents/`、`.codex/`
   - 更新 project tracking manifest

这就是后续实现要坚持的“混合执行、分层建模”。

### `uninstall`

### `--scope project`

默认只做这些事：

- 删除 tracking manifest 记录的 repo-managed artifacts
- 重新聚合剩余插件的共享产物
- 保留 `~/.codex/config.toml` 中的原生 marketplace / plugin 状态

不默认删除用户级原生状态。

### `--scope user`

默认只清理用户级内容：

- `~/.codex/config.toml [plugins.*]`
- 如没有剩余引用，再删除 `[marketplaces.*]`
- `~/.codex/` 下的 user-scope 扩展产物

### `upgrade`

推荐分两层刷新：

1. 刷新原生平面
   - 校验 `~/.codex/config.toml` 中 marketplace source 和 plugin enabled 状态
   - 如版本或 source 漂移，先修正这一层
2. 重新生成 repo-managed artifacts
   - 重建 `.agents/skills`
   - 重建 `.codex/config.toml` 的受管片段
   - 重建 `.codex/rules`、`.codex/hooks.json`、`.codex/agents`

### `status`

输出建议也分两层展示：

1. 原生状态
   - marketplace 是否注册
   - plugin 是否 enabled
   - native version / source 是否与当前仓库匹配
2. repo-managed artifacts 状态
   - tracking manifest 是否存在
   - 每个生成产物是否仍存在
   - 当前项目是否 trusted，哪些产物因为 trust 未生效

不要把“tracking manifest 存在”误报成“插件已原生安装”。

## Trust 约束

实现时必须把 trust 约束当成一等行为，不只是 UI 文案。

### trusted project 中可用

- `.codex/config.toml`
- `.codex/rules/*.rules`
- `.codex/hooks.json`
- `.codex/agents/*.toml`

### untrusted project 中的特殊情况

- 上面这些 project-local config / hooks / execpolicy / agents 可能被加载但禁用
- `.agents/skills` 仍可能被加载

所以 `status` 至少要能区分三种状态：

- 文件不存在
- 文件存在且生效
- 文件存在但当前项目未 trusted，因此未生效

## 不推荐的实现

下面这些做法不建议继续推进：

- 把 project `.codex/config.toml` 里的 `[plugins.*]` 当作原生安装状态
- 把 `~/.codex/plugins/cache` 或其他缓存目录复制进 repo
- 继续把 Codex 指令产物写到 `.codex/AGENTS.md`
- 让 `project uninstall` 直接删用户 `~/.codex/config.toml` 里的插件记录
- 用全局 `installed.json` 表达“某个 repo 的 project scope 是否已初始化”

## 可选变通方案：repo-local `CODEX_HOME`

如果某些场景真的需要“一仓库一套原生用户状态”，可以单独支持显式变通方案：

```bash
CODEX_HOME=$REPO/.codex-home codex ...
```

这类方案的定位应该是：

- 隔离环境
- 临时沙箱
- CI / demo / ephemeral workspace

它不是默认产品语义，也不应和真正的 project `.codex/` 混用。

推荐命名：

- repo project artifacts：`.codex/`
- repo-local user-state sandbox：`.codex-home/`

不要让两者共用同一目录。

## 对当前代码库的落地建议

下面这些点适合作为后续改造 checklist。

### 已经对齐方向的部分

- `packages/cli/src/utils/paths.ts`
  - Codex 原生 registry 强制走 `~/.codex/config.toml`
- `packages/cli/src/commands/common.ts`
  - 已经有“Codex 原生 plugin / marketplace 注册仅支持 user scope”的警告文案
- `packages/cli/src/constants.ts`
  - Codex marketplace 入口已经是 `.agents/plugins/marketplace.json`

### 需要优先修正的部分

- `packages/cli/src/generators/instructions.ts`
  - 不应继续把 Codex 指令输出到 `.codex/AGENTS.md`
- `packages/cli/src/generators/agents.ts`
  - Codex 侧当前输出 `.json`，目标应改成 `.toml`
- `packages/cli/src/adapters/codex.ts`
  - `project uninstall` 不应默认删除用户级原生 plugin 状态
- `packages/cli/src/adapters/codex.ts`
  - 如果后续引入 `.agents/skills` 生成，需要补上对应 tracking 与清理逻辑

### tracking manifest 的短期建议

短期可以继续把 Codex project tracking manifest 放在：

- `.codex/.agent-workflows-manifest.json`

这样可以尽量少改当前代码。

中期如果 project artifacts 明显跨越 `.agents/` 和 `.codex/` 两个根目录，再评估是否提升到 repo 根，例如：

- `./.agent-workflows-manifest.json`

## 最小实施顺序

### Phase 1

- 先把 Codex `project` scope 的产品语义写死为“repo-managed artifacts + user-scope native fallback”
- 补一组 status / uninstall 行为测试，防止再把 project scope 等同于原生安装

### Phase 2

- 修正 Codex 指令和 agent 角色的输出格式
- 把 `.codex/AGENTS.md` 路径从实现里清掉

### Phase 3

- 视需要增加 `.agents/skills` 生成
- 把 status 输出拆成“原生平面 / 仓库平面 / trust 生效状态”三段

## 最终结论

后续 Codex 方案应明确建立在这条判断上：

- **原生插件状态是 user scope**
- **repo-managed artifacts 是 project scope**

两者可以被同一条命令同时触发，但不能共用一份状态模型，更不能把 project `.codex/config.toml` 当成 Codex 原生插件安装真值。
