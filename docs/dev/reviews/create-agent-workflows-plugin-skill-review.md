# `create-agent-workflows-plugin` Skill 实现评审报告

审查对象：`.agents/skills/create-agent-workflows-plugin/`  
审查时间：2026-04-26

本轮审查覆盖：

- `SKILL.md`
- `agents/openai.yaml`
- `scripts/init_plugin.js`
- `scripts/validate_plugin.js`
- `references/*.md`
- 对照实现：`packages/cli/src/utils/manifest.ts`、`packages/cli/src/generators/local-plugin.ts`、`packages/cli/src/adapters/codex.ts`、`packages/cli/src/generators/agents.ts`
- 对照测试：`packages/cli/tests/integration/authoring-tools.test.ts`

本轮实际验证：

- 静态对照 skill 文档、脚手架脚本、校验脚本与 `packages/cli` 当前实现
- 执行 `pnpm --filter @yiliang/aw test -- tests/integration/authoring-tools.test.ts`
  实际跑了全量 `26` 个测试文件、`107` 个用例，全部通过
- 执行 `node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js .agents/skills/create-agent-workflows-plugin/references/example-plugin`
  结果失败，报错 `manifest name "code-review" does not match directory name "example-plugin"`
- 将 `references/example-plugin/` 临时重命名为 `code-review/` 后再次执行同一校验脚本
  结果通过
- 基于 `plugins/git-commit/` 构造越界路径样例，把 manifest 中的 `skills` 改成 `./../shared-skills`
  `validate_plugin.js` 仍返回 `[PASS] All checks passed.`

## 总体结论

这个 skill 的整体方向是对的：

- 源码 manifest、build bundle、本地 marketplace 的边界基本讲清楚了。
- 参考资料按主题拆分，作者在大多数场景下能快速定位到对应规范。
- `init_plugin.js` 已经收敛到“只生成源码结构，不碰 runtime 产物”的正确模型。
- Codex 侧触发策略是保守的，`agents/openai.yaml` 明确关闭了隐式调用。

但这套作者工具还没有完全收口。我这轮确认有 `3` 个中严重度问题和 `1` 个低严重度问题：

- 有两处文档内容已经和真实实现脱节；
- 触发条件在双平台上没有完全对齐；
- `validate_plugin.js` 的定位写得过强，实际能力远弱于当前 schema contract；
- 渐进式披露方向是对的，但入口仍然偏“全量手册”，不够克制。

## Findings

### 1. 中严重度：综合示例把 Codex 的 repo-managed artifacts 写成了 build bundle 产物，和真实实现不一致

位置：

- `.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md:43-51`
- `packages/cli/src/generators/local-plugin.ts:229-351`
- `packages/cli/src/adapters/codex.ts:608-650`
- `packages/cli/src/generators/agents.ts:17-52`

问题：

`comprehensive-example.md` 现在把下面这些内容写成了 Codex bundle 的组成部分：

- `hooks.json`
- `agents toml`
- `rules markdown`

但按当前实现，`bundleLocalPlugin()` 在 build 阶段只会把声明路径下的源码文件复制进平台 bundle，并额外生成 Claude 侧的 `hooks` 和 `agents`：

- Codex bundle 在这里会带上 `skills`、`.mcp.json`、`.app.json`、以及 `fileRules` 选中的源码文件
- Codex 的 instructions / permissions / hooks / agents 并不是在 build 阶段写进 embedded bundle
- 这些 repo-managed artifacts 是在安装阶段由 `CodexAdapter.installExtensions()` 写到目标 scope 配置目录里的

这不是单纯的表述差异，而是会把作者和排障路径一起带偏。按这份示例去理解，开发者会以为：

- `pnpm build` 之后应该能在 bundle 里直接看到 Codex 的 `.toml` / `.rules` / `hooks.json`
- repo-managed artifacts 的问题应该去查 `packages/cli/plugins-dist/`

实际上，这些问题要去查的是安装阶段生成的 scope 文件，而不是 embedded bundle。

另外，现有作者工具回归测试只覆盖了 `SKILL.md`、`plugin-manifest-spec.md` 和 `skills-and-triggers.md`，没有覆盖 `comprehensive-example.md`，所以这类漂移目前不会被测试拦住：

- `packages/cli/tests/integration/authoring-tools.test.ts:143-178`

建议：

- 修正文档里对 Codex bundle 的描述，明确区分“embedded bundle 内容”和“安装阶段生成的 repo-managed artifacts”
- 给 `comprehensive-example.md` 补一条作者工具回归，至少锁住这几个关键名词

### 2. 中严重度：skill 说明要求“用户明确要新增或维护插件”时才使用，但 Claude 侧实际仍然允许模型自动调用

位置：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md:2-3`
- `.agents/skills/create-agent-workflows-plugin/agents/openai.yaml:1-6`
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:29-30`
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:109-136`
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:175-178`

问题：

这个 skill 在 frontmatter 里把触发场景写得很窄：

- 只有当用户明确要在当前仓库新增或维护 `plugins/<name>/` 时才使用

Codex 侧也确实按这个口径配置了：

- `agents/openai.yaml` 里 `allow_implicit_invocation: false`

但 Claude 侧 frontmatter 没有显式写：

- `disable-model-invocation: true`

根据同目录下 `skills-and-triggers.md` 的说明，Claude 的默认值是：

- `user-invocable: true`
- `disable-model-invocation: false`

这意味着这份 skill 在双平台上的触发策略并不一致：

- Codex：保守手动触发
- Claude：仍可能被模型自动调用

对一个高上下文、高修改范围的作者工具 skill 来说，这个默认值偏宽了。它不是“低风险辅助型 skill”，更接近参考文档里写的“保守手动触发”配方。

影响：

- 在 Claude 侧可能出现不必要的自动注入
- 会让 skill 的“触发条件”和“实际配置”两张口径并存
- 也会削弱“按用户明确请求才进入插件作者模式”这条边界

建议：

- 如果产品意图确实是双平台都保守手动触发，就在 `SKILL.md` frontmatter 里补上 `disable-model-invocation: true`
- 如果有意保留 Claude 自动调用，那就要把 `SKILL.md` 顶部描述改成更宽的口径，并说明原因

### 3. 中严重度：`validate_plugin.js` 被写成“检查插件完整性”的统一校验入口，但它既会误报，也会漏报

位置：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md:91`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md:123-137`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md:158`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:17-29`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:74-87`
- `packages/cli/src/utils/manifest.ts:39-49`
- `packages/cli/src/utils/manifest.ts:75-99`
- `packages/cli/src/utils/manifest.ts:657-750`

问题：

`SKILL.md` 当前把 `validate_plugin.js` 放在正式工作流第 7 步，并直接写成“检查插件完整性”。这个定位太强了，因为脚本和真实 manifest contract 之间还有明显落差。

先看漏报：

- 真实实现会拒绝 unknown top-level fields，`validate_plugin.js` 不检查
- 真实实现会拒绝越出插件根目录的路径，`validate_plugin.js` 只检查“是否以 `./` 开头”和“目标是否存在”
- 真实实现会在默认入口文件存在但 manifest 未声明时直接报错，`validate_plugin.js` 不检查
- 真实实现会归一化并校验 `extensions`、`buildConfig`、`manifestOverrides` 等结构，`validate_plugin.js` 基本没有覆盖

我这轮做了一个最直接的复现：

- 复制 `plugins/git-commit/`
- 把 `skills/` 挪到插件目录外
- 把 manifest 里的 `skills` 改成 `./../shared-skills`
- 运行 `validate_plugin.js`

结果脚本返回 `[PASS] All checks passed.`，但这类路径会被真实实现的 `normalizePluginRelativePath()` 明确拒绝。

再看误报：

- `SKILL.md` 把 `references/example-plugin/` 说成“可直接读取的完整示例插件目录”
- 但它的目录名叫 `example-plugin`，manifest 里的真实插件名是 `code-review`
- 直接跑 `validate_plugin.js` 会失败
- 只要把目录临时改名为 `code-review/`，脚本马上就能通过

这会导致两类问题同时存在：

- 作者可能把 `validate_plugin.js` 的通过结果当成“符合当前 contract”
- 作者也可能对官方示例目录跑校验时莫名失败，不知道问题出在示例目录命名而不是示例内容本身

建议：

- 如果保留这个脚本，就把它明确降级为“轻量预检”，不要写成“完整性校验”
- 更稳的做法是让它复用 `packages/cli/src/utils/manifest.ts` 的真实校验逻辑，而不是再维护一套手写弱校验
- `references/example-plugin/` 要么改成 `code-review/`，要么文档里明确写“这是参考目录名，不能直接拿来跑 validate”

### 4. 低严重度：参考资料拆分是合理的，但 `SKILL.md` 入口还不够符合渐进式披露

位置：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md:12-29`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md:35-77`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md:123-158`

问题：

这个 skill 的资料拆分方向是对的，主题也分得清楚：

- manifest
- skills 与触发
- extensions
- buildConfig
- Claude 专属能力
- MCP / apps
- 综合示例

但真正落到 `SKILL.md` 入口时，还是把下面几层信息几乎同时铺开了：

- 全能力矩阵
- 三种常见结构
- 详细验证清单
- 全量参考索引

这会让 skill 更像“作者手册总览页”，而不是“先帮 agent 选最短阅读路径的执行入口”。对简单需求，比如：

- 只新建一个纯 skill 插件
- 只维护 `extensions.instructions`
- 只补一个 Claude command

当前入口都显得偏重。

这不是错误，更像信息组织上的最后一段路没走完。现在已经具备渐进式披露的素材了，只差把入口做成决策式。

建议：

- 在 `SKILL.md` 最前面增加“先判定插件类型”的 3 条最小路径
- 例如：
  - 纯 skill 插件：先读 `plugin-manifest-spec.md` + `skills-and-triggers.md`
  - extension 插件：先读 `plugin-manifest-spec.md` + `extensions-spec.md`
  - Claude 专属能力：再补 `build-config-spec.md` + `claude-only-capabilities.md`
- 保留综合示例和全量矩阵，但放到“需要时再看”的位置

## 优点

除上面的发现外，这套作者工具也有几处明显做得不错：

- `SKILL.md:8-10` 已经把“源码层 / build / 安装”边界讲清楚了，这是当前仓库里最重要的作者认知前提。
- `init_plugin.js:253-317` 的行为是干净的，只生成源码结构，不偷写 runtime marketplace 或平台 manifest。
- `skills-and-triggers.md` 把 Codex 和 Claude 的 skill 触发开关明确拆开了，这个规范本身是清楚的。
- `authoring-tools.test.ts:143-178` 至少已经把最核心的 source-only 模型和几份关键文档锁住了，说明这部分不是完全无测试状态。

## 建议修复顺序

1. 先修 `comprehensive-example.md`，因为这是内容错误，会直接误导作者理解 build 与 install 的边界。
2. 再收紧这份 skill 自己的触发策略，避免双平台口径不一致。
3. 处理 `validate_plugin.js` 的定位问题。
   要么让它复用真实 schema 校验，要么把文档里的承诺降级。
4. 最后再做 `SKILL.md` 的入口瘦身，把渐进式披露做完整。

## 最终判断

如果只看大方向，这个 skill 的总体设计是合理的，也基本符合当前仓库的插件规范。  
但如果把要求提高到“作者照着它做，不会被错误文档、过宽触发或弱校验误导”，那它现在还差一轮收口。

更准确的判断是：

- 结构设计合理
- 触发条件在 Codex 侧合理、在 Claude 侧还没完全对齐
- 主要内容大体正确，但已有两处实现级漂移
- 渐进式披露有基础，但入口还可以再收一层
