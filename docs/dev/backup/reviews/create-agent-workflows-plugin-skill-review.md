# `create-agent-workflows-plugin` skill 复审报告

审查对象：`.agents/skills/create-agent-workflows-plugin/`  
审查时间：2026-04-27  
审查范围：`SKILL.md`、`agents/openai.yaml`、`scripts/`、`references/`，并交叉核对 `packages/cli/tests`、`packages/cli/src`、Codex 源码 `/Users/LeslieChan/Desktop/codex/codex-rs`、Claude Code 源码 `/Users/LeslieChan/Desktop/claude-code-source-code/src`。

## 主要发现

本轮未发现需要继续跟进的实现问题。

上一版报告里唯一仍未闭环的 `agents/openai.yaml.policy.products` 缺口已经修复；更早几轮报告里的开放问题也没有看到回归。当前这份 skill 的实现、参考文档和测试覆盖已经重新对齐。

## 上轮问题回归

### 1. `openai.yaml.policy.products` 缺口

结论：已修复。

证据：

- `validate_plugin.js` 已把 `products` 纳入 `policy` 合法字段，并校验其必须为数组、数组项必须是合法产品值，见 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:755-780`。
- `references/skills-and-triggers.md` 已把 `policy.products` 写入 `agents/openai.yaml` 完整字段示例，并在 `policy` 小节补充了使用场景和支持值，见 `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:74-119`。
- 集成测试已覆盖“标量应报错、合法数组应通过”两条路径，见 `packages/cli/tests/integration/authoring-tools.test.ts:617-699`。
- Codex runtime 侧仍然把 `products` 作为 `SkillPolicy` 的正式字段解析，并接受小写值与全大写别名，见 `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs:25-53`、`/Users/LeslieChan/Desktop/codex/codex-rs/protocol/src/protocol.rs:3419-3425`。

复核结果：

- 上一版报告里提到的“合法 Codex skill metadata 会被误报为未知字段”问题，这次没有复现。

### 2. 上一版报告里的其他开放问题

结论：仍保持修复状态。

现状：

- `validate_plugin.js` 继续覆盖 Codex skill metadata、`dependencies.tools[]`、`icon_*`、`brand_color` 等关键约束，见 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:638-735`。
- `shell: PowerShell` 的大小写兼容仍然在，当前实现仍会先 `trim().toLowerCase()` 再比对，见 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js:480-484`；Claude Code 自身的 frontmatter 解析逻辑也保持同样行为，见 `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/frontmatterParser.ts:351-369`。
- `allowed-tools` 文档仍然明确写成 `string | string[]`，主 skill 文档和 Claude 专属说明口径一致，见 `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md:25-36`、`.agents/skills/create-agent-workflows-plugin/references/claude-only-capabilities.md:67-74`。

## 总体判断

这份 skill 现在的总体设计是合理的，符合当前仓库定义的 skill/source contract，也符合渐进式披露原则。

从结构上看：

- 主 `SKILL.md` 先按场景 A / B / C 分流，再给出能力速查和最小工作流，字段细节下沉到各 reference 文档，阅读路径短而清楚，见 `.agents/skills/create-agent-workflows-plugin/SKILL.md:11-118`。
- 主文档明确写出“这里描述的是 `agent-workflows` 源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集”，边界表达准确，见 `.agents/skills/create-agent-workflows-plugin/SKILL.md:9`。
- `scripts/init_plugin.js` 负责最小骨架，`scripts/validate_plugin.js` 负责作者工具校验，`references/.examples/code-review/` 提供完整样例，职责划分自然，没有把 schema 细节堆回主入口文档。

## 分项结论

### 1. 报告发现的问题是否修复

结论：是。

上一版报告列出的遗留问题已经修复，这轮没有看到回归。

### 2. skill 总体设计是否合理，是否符合 skill 规范，是否符合渐进式披露原则

结论：合理，符合规范，也符合渐进式披露原则。

补充判断：

- 主入口文档没有把全部 schema 平铺，而是先帮助作者判断“我要做的是哪一类插件”，然后再按需跳转到更细的参考文档。
- 文档、脚手架和 validator 之间的边界比较清楚：主 `SKILL.md` 讲工作流，`references/*.md` 讲字段规范，脚本负责落地和校验。

### 3. skill 触发条件是否合理

结论：合理。

补充判断：

- skill frontmatter 明确把适用范围收束到“在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目”，不会轻易误吸到普通插件使用或安装场景，见 `.agents/skills/create-agent-workflows-plugin/SKILL.md:1-5`。
- Claude 侧通过 `disable-model-invocation: true` 关闭模型自动调用，Codex 侧通过 `policy.allow_implicit_invocation: false` 关闭隐式调用，和这类高写入、强结构约束的作者工具定位一致，见 `.agents/skills/create-agent-workflows-plugin/SKILL.md:1-5`、`.agents/skills/create-agent-workflows-plugin/agents/openai.yaml:1-6`。
- Claude Code 对 `user-invocable` 的默认值仍是 `true`，因此主 skill 不显式写该字段也不会失去用户手动入口，见 `/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts:216-219`。

### 4. skill 内容是否正确，是否有遗漏，是否存在重复需要精简地方

结论：当前内容正确，没有再看到实质性遗漏；重复控制也合适。

补充判断：

- 之前缺的 `policy.products` 现在已经补齐到实现、文档和测试三处，没有再看到类似的 schema 漏项。
- `references/.examples/code-review/` 同时出现在“参考文档索引”和“现有样例”里，但一个是索引，一个是学习入口，重复度很轻，不需要为了压缩篇幅强行合并。

## 验证记录

已核对：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md`
- `.agents/skills/create-agent-workflows-plugin/agents/openai.yaml`
- `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`
- `.agents/skills/create-agent-workflows-plugin/references/*`
- `docs/plugin-authoring.md`
- `packages/cli/tests/integration/authoring-tools.test.ts`
- `packages/cli/src/adapters/codex.ts`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/protocol/src/protocol.rs`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/frontmatterParser.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts`

已运行：

- `node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js .agents/skills/create-agent-workflows-plugin/references/.examples/code-review`
- `pnpm --filter @lesliechan721/aw exec vitest run tests/integration/authoring-tools.test.ts`

结果：

- `references/.examples/code-review` 当前校验通过
- `authoring-tools.test.ts` 14/14 通过
- 上一版报告中的遗留问题没有复现
- 本轮未发现新的实现问题
