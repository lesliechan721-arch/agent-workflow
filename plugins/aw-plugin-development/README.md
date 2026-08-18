# AW Plugin Development

面向本仓库维护者的 AW 插件作者和评审适配层。

该插件把 `agent-content-toolkit` 的通用内容、Skill 和 Eval 能力映射到 `agent-workflow` 仓库的 manifest、构建、materialization、版本和发布约定。两个 Skill 都是显式入口。

## 安装

先安装通用工具包，再安装本插件：

```bash
aw install agent-content-toolkit -p both
aw install aw-plugin-development -p both
```

当前依赖由安装者人工保证。缺少必需通用 Skill 时，适配器会停止并报告缺失，不复制另一份标准。

## 包含的 Skill

| Skill | 作用 | 写入 |
| --- | --- | --- |
| [`author-aw-plugin`](skills/author-aw-plugin/) | 创建或维护 AW 插件，修改源码、构建并运行确定性验证 | 是 |
| [`review-aw-plugin`](skills/review-aw-plugin/) | 只读评审源码、最终物化产物和 Eval 证据 | 否 |

## 典型用法

```text
使用 author-aw-plugin 在 agent-workflow 仓库新增一个双平台插件。
```

```text
使用 review-aw-plugin 独立审查这个插件的源码、Codex 最终制品和 Eval 证据。
```

## 边界

- Author 不为自己的修改生成独立发布结论。
- Reviewer 不修改生产源码。
- 报告发布和 README 登记需要单独授权。
- 当前真实模型证据范围以 Codex 为主；Claude 侧执行确定性校验与 materialization。
- 迁移期间不会静默替换仓库已有作者和评审入口。

## 维护者

```bash
node scripts/validate-contract-assets.mjs
pnpm plugin:test aw-plugin-development
```
