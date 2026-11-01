# AW 来源与运行包

解析 source、final、profile、修改 owner 或可比较版本时读取。导出标准 Agent Skills 使用 Portable 分发（`references/portable-skills.md`）；选择共享构建机制使用 构建与共享（`references/build-and-sharing.md`）。

## 定位本次对象

目标可为 Plugin root、manifest、源 Skill root、SKILL.md 或明确的动态 source/target。单 Skill 由所属 Plugin 解释构建和依赖，证据范围只包含所选 Skill 及必要共享输入。歧义会改变目标时先确定对象。

已有源码足以支持本次分析时直接读取。需要 CLI 来源证据时，在主入口的能力检查后运行：

```bash
aw review inspect <target> --view review --json
```

按需使用当前帮助支持的 `--skill`、`--platform`、`--scope`、`--config`；已有绑定通过 `--materialization` 提供。用户已给完整标准包且不要求 AW 来源核验时，可直接采用该包。

Inspection 是静态取证，不运行插件代码、build、test、模型或网络。`ok` 表示取证完成；只有 `ready` final 代表本次当前选择。文件存在、与当前输入不匹配的绑定或其他 profile 的成功不能替代当前性。

Catalog snapshot 的 `current` 表示有效且匹配当前 source；`stale` 表示产物与当前 source 不匹配；`absent` 表示缺少证据；`invalid` 保留实际诊断。Catalog 取证不默认展开所有 leaf 的运行包。

## 准备缺少的 final

先读取 `aw review prepare --help`，固定 target、platform、scope 和影响内容的配置。沿用已明确配置，由 CLI 校验默认值；只补齐会改变本次结果的缺失输入。

完整产物任务所需的本地准备，在已有授权内继续。先说明会执行必要依赖闭包的 build/runtime imports 和所选 renderer，并向新隔离目录生成副本。仅允许静态读取时保留源码结论。`plugin validate` 可能运行 renderer fixture，`plugin status` 可能准备 bundle，不能用它们绕过执行限制。

```bash
aw review prepare <plugin-or-source-skill> --platform <platform> \
  --scope <scope> --out <new-directory> --json
```

按需提供 `--config <file>` 或 `--skill`。采用用户指定的新目录，或规范化可写临时根下的新目录。准备不依赖 Eval suite，也不授权修改源、真实安装或模型运行。Native 包无需 Portable 声明；`agent-skills` 产物仍需显式分发声明。

从成功回执取得 `skills[].finalPath`、profile、digest 与 `sourceBindingPath`，使用真实返回路径。本次检查可直接使用该回执；跨请求复用，或 source/profile/依赖/产物变化后重新 inspect。失败时保留实际错误和可支持的源码结论，不匹配的绑定通过公开入口重新生成。

## 确认修改 owner

沿 manifest、provider、imports/exports 和 renderer 找到内容来源。问题位置记录 final/path/profile；修改位置记录权威 Skill source、共享 provider 或构建规则。映射不足时保留 owner 未确认，不直接编辑 final。共享 provider 影响其他消费者时核对当前授权和验证范围。

## 准备可比较版本

调用者需要基线或候选时，每份输入保留必要的 Workspace marker/metadata、manifest、依赖、build/runtime imports、provider、renderer、非敏感配置及相关未提交、未跟踪文件。HEAD 或单独 Skill 目录不能代表完整当前输入；版本选择和候选制作仍由调用者决定。

各版本在自己的源码上下文中，使用相同 platform、scope、解析后配置和未变构建条件准备，分别核验来源绑定。source/provider/renderer 改变后重新准备。同名 profile 不证明 target 相同；运行器再次物化时核对实际 current/previous target，模型执行与 Audit 仍由运行器负责。

应用已授权的 source diff 前，核对原工作区相关输入并协调并行修改；应用后按 Plugin 开发（`references/plugin-development.md`） 验证对应产物和受影响消费者。

## 核对与交付证据

引用、注入资源、调用 metadata 和运行依赖在所选当前 final 上核对。只做 source-design 时，说明待生成内容，不把源码中尚未生成的资源判为 final 缺陷。源 Eval 可作为辅助证据，不要求随运行包分发。

同一正文在不同 profile 下可能有不同权限、调用策略与环境要求。production digest 相同且权限、profile 与适用规范等价时，可复用内容分析；实际环境覆盖分别核验，一个平台通过不能替代其他平台或 Portable 的检查。

按本次实际取证交付 source 或 final、所选 profile、digest、全部来源绑定、修改 owner 和未知项。未准备或未检查的产物明确说明。AW 组合判断使用 领域依据（`references/aw-domain-review.md`），质量与候选接受由当前任务的方法裁决。
