# `create-agent-workflows-plugin` Skill 实现复审报告

审查对象：`.agents/skills/create-agent-workflows-plugin/`  
审查时间：2026-04-26

本轮审查覆盖：

- `SKILL.md`
- `agents/openai.yaml`
- `scripts/init_plugin.js`
- `scripts/validate_plugin.js`
- `references/*.md`
- 对照实现：`packages/cli/src/utils/manifest.ts`、`packages/cli/src/generators/local-plugin.ts`、`packages/cli/src/adapters/codex.ts`、`packages/cli/src/generators/{instructions,permissions}.ts`
- 对照测试：`packages/cli/tests/integration/authoring-tools.test.ts`
- 权威对照源码（本地 checkout）：
  - Codex：`/Users/LeslieChan/Desktop/codex/codex-rs`
  - Claude Code：`/Users/LeslieChan/Desktop/claude-code-source-code/src`

本轮实际验证：

- 静态对照 skill 文档、脚手架脚本、校验脚本与 `packages/cli` 当前实现
- 执行 `pnpm --filter @yiliang/aw test -- tests/integration/authoring-tools.test.ts`
  实际跑了全量 `26` 个测试文件、`107` 个用例，全部通过
- 执行 `node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js .agents/skills/create-agent-workflows-plugin/references/code-review`
  结果通过
- 复制 `references/code-review/` 到临时目录，把 manifest 中的 `skills` 改成 `./../shared-skills`，并保证越界目标真实存在
  `validate_plugin.js` 返回 `Invalid skills: path must stay inside the plugin root.`
- 用 `init_plugin.js` 在临时仓库生成 `repo-check` 插件骨架
  生成的 `SKILL.md` 只有 `name` / `description` 两个 frontmatter 字段；生成的 `agents/openai.yaml` 固定写入 `allow_implicit_invocation: false`
- 对照平台源码确认默认行为：
  - Codex：`allow_implicit_invocation` 缺省时默认允许隐式调用
  - Claude Code：`user-invocable` 缺省为 `true`，`disable-model-invocation` 缺省为 `false`
  - Codex 当前 loader 对 `interface.short_description` 的实际约束是“非空且不超过 1024 字符”，不是 `25-64`

## 总体结论

上轮报告里的核心问题，这次基本都修到了位：

- `references/comprehensive-example.md` 现在已经把 build 阶段 bundle 和 Codex 安装阶段生成的 repo-managed artifacts 分开描述；
- 当前这个 skill 自己的触发口径已经双平台对齐，`SKILL.md` 明确写了 `disable-model-invocation: true`，`agents/openai.yaml` 也关闭了 Codex 隐式调用；
- `validate_plugin.js` 在 CLI 已构建时会复用真实 manifest 校验逻辑，越界路径样例已经能被拦住；
- `SKILL.md` 入口重写成按场景选最短阅读路径，整体上已经符合渐进式披露，而不是一上来把全手册平铺出来。

现在这套 skill 的总体设计是合理的：

- 触发条件保守，边界清楚，符合“用户明确要新增或维护插件时再进入作者模式”的定位；
- 参考资料拆分按主题划分，绝大多数场景都能走最短路径；
- `完整参考` 和 `参考文档索引` 虽然有少量重叠，但一个偏按能力查，一个偏按文档查，我认为还不需要为了压缩篇幅强行合并。

不过这轮复审仍然发现 `1` 个中严重度问题和 `2` 个低严重度问题。

## 上轮问题复核

### 1. 已修复：综合示例不再把 Codex 的 repo-managed artifacts 误写成 build bundle 内容

位置：

- `.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md:43-53`
- `packages/cli/src/generators/local-plugin.ts:229-351`
- `packages/cli/src/adapters/codex.ts:608-650`
- `packages/cli/src/generators/instructions.ts:70-97`
- `packages/cli/src/generators/permissions.ts:21-39`

结论：

文档现在已经明确区分：

- build 阶段进入 bundle 的内容
- Codex 安装阶段写入 repo scope 的 instructions / permissions / hooks / agents 产物

这点和当前 CLI 实现已经一致。

### 2. 已修复：skill 自身的双平台触发策略已经统一成保守手动触发

位置：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md:1-4`
- `.agents/skills/create-agent-workflows-plugin/agents/openai.yaml:1-6`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts:216-258`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs:24-30`

结论：

当前 skill 已显式写出：

- Claude Code：`disable-model-invocation: true`
- Codex：`allow_implicit_invocation: false`

考虑到两个平台的默认值分别是“Claude 允许模型调用”和“Codex 允许隐式调用”，这次补齐是必要且正确的。

### 3. 已修复：`validate_plugin.js` 不再放过越界路径，示例目录也能直接校验

位置：

- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:33-50`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:255-276`
- `.agents/skills/create-agent-workflows-plugin/references/code-review/.agents-plugin/plugin.json:1-100`
- `packages/cli/src/utils/manifest.ts:75-99`
- `packages/cli/src/utils/manifest.ts:657-718`

结论：

- `references/code-review/` 现在目录名和 manifest 名一致，直接跑脚本可以通过
- 当 `packages/cli/dist/` 存在时，脚本会走真实的 `validatePluginManifest()`，越界路径能被拦住

### 4. 已修复：入口已经明显更符合渐进式披露

位置：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md:11-57`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md:59-95`

结论：

当前入口先按插件形态把阅读路径切成 A / B / C 三类，再把全量能力矩阵和索引放到后面，信息组织比上一版克制得多。

## Findings

### 1. 中严重度：`init_plugin.js` 生成的新 skill 仍然默认落在“Codex 保守手动、Claude 允许模型调用”的不一致状态

位置：

- `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js:90-122`
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:107-136`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts:216-258`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs:24-30`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/commands/init.ts:182`

问题：

脚手架脚本现在会同时生成两份平台元数据，但默认策略并不一致：

- `renderOpenAiYaml()` 固定写 `allow_implicit_invocation: false`
- `renderSkillMd()` 只写 `name` 和 `description`，没有补 `disable-model-invocation: true`

而平台源码的真实默认值是：

- Codex：`allow_implicit_invocation` 缺省时为 `true`
- Claude Code：`user-invocable` 缺省为 `true`，`disable-model-invocation` 缺省为 `false`

这意味着脚手架一落地，默认行为就是：

- Codex：只能显式 `$skill-name`
- Claude Code：用户可手动调用，模型也仍可自动调用

这和当前 skill 自己倡导的“保守手动触发”配方不一致，也会让新作者误以为两端都已经被收紧了。

建议：

- 最直接的修法是在生成的 `SKILL.md` frontmatter 里补上：
  - `user-invocable: true`
  - `disable-model-invocation: true`
- 如果产品意图其实是“脚手架保持中性，不预设触发策略”，那就不要只在 Codex 侧强行写 `allow_implicit_invocation: false`，而应让两端都显式留空，再在模板正文里提示作者自己选配方。

### 2. 低严重度：`skills-and-triggers.md` 把 `interface.short_description` 写成了硬约束，但 Codex 源码实际只做更宽松的长度校验

位置：

- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:74-97`
- `.agents/skills/create-agent-workflows-plugin/agents/openai.yaml:1-6`
- `.agents/skills/create-agent-workflows-plugin/references/code-review/skills/review/agents/openai.yaml:1-6`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/loader.rs:110-113`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/loader.rs:745-748`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/loader.rs:879-893`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/loader_tests.rs:1205-1227`

问题：

文档把 `short_description` 写成“`25-64` 字符”，读起来像硬性 contract；但从 Codex 源码看，当前实际行为是：

- 只做非空和最大长度校验
- 最大长度走的是 `MAX_SHORT_DESCRIPTION_LEN = MAX_DESCRIPTION_LEN = 1024`
- 并没有 `25` 的最小长度约束，也没有 `64` 的上限约束

同时，仓库里自己的示例也没遵守这个写法：

- 当前 skill 的 `agents/openai.yaml` 用的是 `按当前 manifest 和 bundle 规则创建插件`
- `references/code-review` 的 `short_description` 也是明显短于 `25` 字符的中文短句

这会把“平台建议”和“平台硬约束”混在一起。作者很难判断：

- 哪些是必须满足的 contract
- 哪些只是更利于 UI 展示的推荐写法

建议：

- 如果要保留这条经验规则，建议改成“推荐保持在 `25-64` 字符，便于 UI 快速扫读；Codex 当前 loader 的实际校验更宽松”
- 如果希望文档只描述当前真实 contract，就直接删掉 `25-64` 的硬性表述

### 3. 低严重度：这轮修复还缺少回归测试保护，后续仍有回漂风险

位置：

- `packages/cli/tests/integration/authoring-tools.test.ts:143-178`
- `.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md:43-53`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:33-50`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:255-276`

问题：

当前回归测试只锁住了：

- `SKILL.md`
- `plugin-manifest-spec.md`
- `skills-and-triggers.md`

但这轮真正修过、也最容易再次漂移的两个点，仍然没有自动化保护：

- `comprehensive-example.md` 对 build / install 边界的描述
- `validate_plugin.js` 在“CLI 已构建”和“路径越界”场景下的真实行为

也就是说，这次修复虽然已经生效，但它们仍主要依赖人工 review，而不是测试来兜底。

建议：

- 给 `comprehensive-example.md` 补一个最小文本回归，至少锁住 “Codex 安装时生成 repo-managed artifacts” 这组关键词
- 给 `validate_plugin.js` 补一个脚本级测试：
  - `references/code-review/` 可直接通过
  - `./../shared-skills` 这类越界路径在 CLI 已构建时必须失败

## 优点

除上面的发现外，这套 skill 现在也有几处明显做得不错：

- `SKILL.md:11-57` 的场景化入口已经能把“只建 skill”“只做 extensions”“混合型/Claude 专属能力”三类路径拆开，渐进式披露基本成立。
- `SKILL.md:59-72` 的工作流顺序合理，先定能力组合，再改 manifest，再 build / validate / test，和仓库实际开发路径一致。
- `validate_plugin.js` 现在优先复用 `packages/cli/dist` 的真实 manifest 校验，这个方向是对的，比继续维护一套孤立的弱校验可靠得多。
- `references/code-review/` 现在既能直接跑校验，又和 `comprehensive-example.md` 配套，作为完整样例的可用性已经比上一版好很多。

## 建议修复顺序

1. 先修 `init_plugin.js` 的默认触发策略不一致问题，这是当前唯一还会直接影响新插件默认行为的实质性问题。
2. 再修 `skills-and-triggers.md` 里 `short_description` 的约束表述，避免把推荐写法写成硬 contract。
3. 最后补回归测试，把这次已修复的边界固定下来。
