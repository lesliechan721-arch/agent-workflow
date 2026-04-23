# `npm-plugin-marketplace.md` 复审报告

审查对象：`docs/dev/plans/npm-plugin-marketplace.md`

审查范围：基于当前仓库基线，对执行计划本身做复审，不审代码实现

审查基线：

- 当前 `packages/cli` 实现
- 当前单元 / 集成测试
- `Codex` 源码：`/Users/LeslieChan/Desktop/codex/codex-rs`
- `Claude Code` 源码：`/Users/LeslieChan/Desktop/claude-code-source-code/src`

审查时间：2026-04-23

补充前提：当前仍处于开发阶段，不要求兼容历史安装态、旧 marketplace 名或旧落盘产物。

## 结论

这版计划比上一轮又收敛了一截。上一轮最关键的两个问题，这次可以明确关闭：

- Claude 三层状态模型已经按上游真实分层补齐
- `buildConfig` / manifest override 已经从本期方案里拿掉，`requiresNativePlugin` 口径不再自相矛盾

按“基于当前基线可落地、文档自洽、测试可兜底”的标准看，计划现在还剩 3 处需要补写或补测，严重度都在中等。它们不会推翻整体方向，但如果不补，实施时很容易在真实 Claude 环境、仓库内部脚手架，或者 npm 发包链路上留下缺口。

## 发现

### 1. 中严重度：Claude 的“真实状态源”还少了 plugins 目录 override 和 seed 目录语义

位置：

- `docs/dev/plans/npm-plugin-marketplace.md:33-41`
- `docs/dev/plans/npm-plugin-marketplace.md:52-56`
- `docs/dev/plans/npm-plugin-marketplace.md:425-437`

问题：

计划已经把 Claude 模型改成了 settings / `known_marketplaces.json` / `installed_plugins.json` 三层，这部分方向是对的。但文档现在仍把“Claude 全局 plugins 目录”近似写成默认的 `~/.claude/plugins`，没有把上游源码里的两层路径语义写进去：

- primary plugins 目录可以被 `CLAUDE_CODE_PLUGIN_CACHE_DIR` 改写
  - `claude-code-source-code/src/utils/plugins/pluginDirectories.ts:46-63`
- 还存在只读 seed 层 `CLAUDE_CODE_PLUGIN_SEED_DIR`
  - `claude-code-source-code/src/utils/plugins/pluginDirectories.ts:66-89`
- Claude 启动时会先把 seed marketplace 注册进 primary `known_marketplaces.json`
  - `claude-code-source-code/src/utils/plugins/marketplaceManager.ts:353-430`
  - `claude-code-source-code/src/utils/plugins/headlessPluginInstall.ts:49-58`

这会直接影响计划里的 `status / upgrade / uninstall`，因为这些命令被写成要按“真实状态源”去读文件。如果实现时只按固定的 `~/.claude/plugins` 读取 `known_marketplaces.json` 和 `installed_plugins.json`，在容器化或企业环境下就可能：

- 读错 primary plugins 目录
- 把 seed 已注册 / 已物化的 marketplace 误判成缺失
- 让 CLI 状态输出和 Claude 自己实际看到的插件状态不一致

建议：

- 把“Claude 全局 plugins 目录”改写成“按 Claude 上游 `getPluginsDirectory()` 解析出的 primary plugins 目录”，不要只写默认路径
- 明确说明本期是否支持 `CLAUDE_CODE_PLUGIN_SEED_DIR`
- 如果首版不支持 seed，文档里要把它列成已知限制，而不是继续写成“真实状态源”
- 测试里至少补 2 条：
  - `CLAUDE_CODE_PLUGIN_CACHE_DIR` 改写路径后的状态读取
  - seed marketplace 注册后，`status` / `upgrade --all` 的判定不误报

### 2. 中严重度：迁移范围还没有把仓库里的作者工具和关联文档一起收口，计划和当前基线会继续双轨并存

位置：

- `docs/dev/plans/npm-plugin-marketplace.md:199-206`
- `docs/dev/plans/npm-plugin-marketplace.md:662-684`
- `docs/dev/plans/npm-plugin-marketplace.md:690-693`

问题：

计划正文已经明确要删除 repo 根 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`，以及源码树里的 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`，运行时只认 `plugins-dist` 和 `~/.aw`。但“涉及文件”里只把 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 列为需要同步的作者侧资产，这个范围明显不够。

当前基线里，至少还有这几类仓库内资产仍然强绑定旧模型：

- 插件脚手架脚本还会直接创建源码树里的平台 manifest，并改 repo 根 marketplace
  - `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js:61-68`
  - `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js:248-295`
- 同一个 skill 的参考契约仍把 repo 根 marketplace 和源码树平台 manifest 当成稳定结构
  - `.agents/skills/create-agent-workflows-plugin/references/project-plugin-contract.md:13-45`
- 被当前计划直接引用的 `codex-repo-managed-artifacts.md` 仍把 repo marketplace 写成 `.agents/plugins/marketplace.json`
  - `docs/dev/plans/codex-repo-managed-artifacts.md:64-88`
- 现有测试夹具也仍然内置 repo 根 marketplace 文件
  - `packages/cli/tests/fixtures/repo-template/.claude-plugin/marketplace.json:1-24`
  - `packages/cli/tests/fixtures/repo-template/.agents/plugins/marketplace.json:1-24`

如果计划不把这些迁移范围写出来，落地时很容易出现这种情况：

- CLI 运行时链路已经改成 `plugins-dist` / `~/.aw`
- 内部脚手架还在生成旧目录
- 关联文档还在指导开发者维护旧入口
- 测试夹具还在默认 repo 根 marketplace 存在

这不是单纯的“文档后补”问题，而是当前基线下会持续制造新漂移源的问题。

建议：

- 把作者侧资产的迁移范围写全，至少补上：
  - `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`
  - `.agents/skills/create-agent-workflows-plugin/references/*.md`
  - `packages/cli/tests/fixtures/repo-template/**`
  - `docs/dev/plans/codex-repo-managed-artifacts.md`，或者明确声明它在本方案下哪些段落失效
- 如果有意保留旧脚手架一段时间，也要在计划里明确“它只兼容开发态，不再代表运行时真相源”，否则当前文档体系本身就不自洽

### 3. 中严重度：测试矩阵还缺 npm 发包闭环校验，主目标是“发出去的包可用”，但现在只测到了“仓库里的 build 输出可用”

位置：

- `docs/dev/plans/npm-plugin-marketplace.md:145-150`
- `docs/dev/plans/npm-plugin-marketplace.md:699-780`

问题：

这份计划的首要目标之一，是“发布 `@yiliang/aw` 到私有 npm 仓库，并让 npm 包自带可安装的运行时插件 bundle”。但当前测试矩阵虽然覆盖了：

- `bundle-plugins.js` 的目录输出
- `plugins-dist` 与 `~/.aw` 的镜像关系
- `aw init` 只复制、不二次生成

却没有任何一条测试或验收项真正触达“最终打出来的 npm 包”本身。也就是说，下面这些问题即便存在，现有测试矩阵也可能全部通过：

- `files` 配置漏掉 `plugins-dist`
- `build` / `prepack` 没把 `bundle-plugins.js` 串进发包链路
- tarball 里有 `dist/index.js`，但没有 `plugins-dist/**`
- 从打包产物安装后，`resolveEmbeddedPluginsRoot()` 找不到真正随包发布的目录

当前基线的 `packages/cli/package.json` 也还只有纯 `tsc` 的 `build` 脚本，没有任何 pack 级保护：

- `packages/cli/package.json:1-28`

建议：

- 至少补 1 条 pack smoke test，方式可以很轻：
  - 跑一次 `pnpm pack` 或 `npm pack`
  - 解开 tarball
  - 断言包内存在 `dist/index.js`、`plugins-dist/.claude-plugin/marketplace.json`、`plugins-dist/.agents/plugins/marketplace.json`、`plugins-dist/plugins/<sample-plugin>/...`
- 如果不想在自动化测试里真的打包，也至少在验收标准里明确加一条“以 tarball 内容为准”的人工验收
- 最稳妥的做法，是把“bundle 生成”挂进 pack 链路，并让 pack smoke test 成为 CI 必跑项

## 已关闭项

和上一轮报告相比，下面两项这次可以明确关闭：

- Claude 原生状态已经按上游源码拆成了声明层、物化层、安装记录层
  - 计划里的 settings / `known_marketplaces.json` / `installed_plugins.json` 分层，已经和 Claude Code 上游模型对齐
- `buildConfig` / manifest override 的自相矛盾口径已经移除
  - 当前计划不再引入额外的 build-time override，`requiresNativePlugin` 也不再和“最终 runtime manifest”形成双重真值

## 测试覆盖评估

这版测试矩阵已经比上一轮完整很多，尤其是下面这些方向已经进了正文：

- `~/.aw` 同版本损坏后的自动修复
- Claude `project` scope 对 `installed_plugins.json` 的当前项目相关性判断
- instruction-only Codex 插件在 `user` / `project` 下的初始化语义
- fake native CLI 调用链，不再依赖本机真实二进制

但按当前基线和计划自己的状态模型看，仍然建议补 3 组回归：

- Claude plugins 目录 override / seed 目录回归
  - 覆盖 `CLAUDE_CODE_PLUGIN_CACHE_DIR`
  - 覆盖 seed marketplace 已注册后的状态判定
- npm tarball smoke
  - 验证 pack 产物确实带上 `dist` 与 `plugins-dist`
- Codex native-only project scope 回归
  - 当前基线的 tracking 数据模型本质上还是“按 artifact 记账”
    - `packages/cli/src/types.ts:87-95`
    - `packages/cli/src/utils/tracking.ts:40-52`
  - 但计划把 Codex `project` 的 `effectiveInitialized` 完全建立在 tracking manifest 上
    - `docs/dev/plans/npm-plugin-marketplace.md:123-139`
    - `docs/dev/plans/npm-plugin-marketplace.md:563-580`
  - 所以最好显式补一条“`requiresNativePlugin=true`、但没有 repo-managed artifact 的插件，在 `project` 安装后仍能留下 initialized 记录”的回归测试，否则这条分支最容易在实现时漏掉

## 总结

这份计划现在已经从“主体方向对，但关键真值模型没写实”推进到了“整体可做，但还有几处真实环境和交付链路的细节没补齐”的状态。

如果只看主链路设计，方案已经可以进入实现准备；但要成为一份真正稳的实施规格，建议先把下面 3 件事补实：

- 把 Claude 的 primary plugins 目录 / seed 语义写清楚
- 把仓库内脚手架、参考文档和夹具的迁移范围写全
- 给 npm 发包产物补一条真正的闭环校验
