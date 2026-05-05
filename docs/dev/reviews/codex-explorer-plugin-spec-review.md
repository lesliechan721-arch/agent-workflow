# `codex-explorer-plugin-spec.md` 复审报告

审查对象：`docs/dev/specs/codex-explorer-plugin-spec.md`
审查时间：2026-05-03

## Findings

本轮复审没有再发现需要继续修改 spec 的问题。

上一轮报告里留下的两条低风险问题，这一版都已经补进了正式需求约束里；我也没有再看到新的逻辑漏洞、基线断层，或会让实现阶段出现明显分叉的表述。

## 复审结论

### 1. 需求合理性与逻辑完整性

当前 spec 的主链路已经闭环，关键边界也都写得足够明确：

- 动态 artifact 的安装前能力真值来自 `artifacts.targets`，不是运行时执行 renderer 才临时推断：
  - `docs/dev/specs/codex-explorer-plugin-spec.md:56-67`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:163-219`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:410-421`
- `aw status` 被明确限定为只读路径，不执行 renderer 或 lifecycle：
  - `docs/dev/specs/codex-explorer-plugin-spec.md:303-310`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:447-449`
- user/project 两层的 render config 口径已经拆开，避免仓库内 project config 污染 user scope artifact：
  - `docs/dev/specs/codex-explorer-plugin-spec.md:257-267`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:455-466`
- 共享 `.codex/config.toml` 的变更已经被收口到单次文档级事务，不再留下“一种 target 写一次文件”的空子：
  - `docs/dev/specs/codex-explorer-plugin-spec.md:60-67`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:463-464`
- `codex.agentRole` 的冲突检测、刷新身份校验和 status 诊断，已经统一落到 Codex 最终 role 名空间，而不是只按文件名或 table key 猜：
  - `docs/dev/specs/codex-explorer-plugin-spec.md:395-406`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:438-449`
  - `docs/dev/specs/codex-explorer-plugin-spec.md:616-624`

我的判断是：需求本身现在是自洽的。默认轻量 instruction、手动 skill + 专用 role、artifact renderer、config-triggered refresh 这四块之间没有再互相打架，也没有再看到明显的逻辑缺口。

### 2. 是否能在当前基线下落地

可以落地，而且主要是沿现有基础设施做增量扩展，不是推翻重做。

我确认了几处现成能力，说明这份 spec 不是“纸面可行、代码基线接不住”：

- Codex config 已经有共享文件事务写入原语，可承接 spec 要求的单事务 apply：
  - `packages/cli/src/utils/codex-config.ts:1390-1413`
- Codex project scope 已经有成型的写入前安全预检链路，可复用到 install、upgrade 和 config-triggered refresh：
  - `packages/cli/src/commands/codex-project-safety.ts:281-360`
- Codex project managed surface 目前已经集中在统一入口判断，后续把动态 `artifacts.targets` 并进去是顺着现有抽象扩展：
  - `packages/cli/src/utils/codex-project-surface.ts:117-174`

同时，当前基线里也确实还有几块需要补齐，但这些都属于明确的工程实现项，不是 spec 层面的断裂：

- manifest schema 和类型系统目前还不认识 `artifacts`、`scripts.artifacts.render`：
  - `packages/cli/src/utils/manifest.ts:1372-1399`
  - `packages/cli/src/types.ts:242-257`
- tracking 现在仍是 path-first 结构，还没有 artifact id、target、state、config digest 这些动态 artifact 元数据：
  - `packages/cli/src/types.ts:324-335`
- 当前 Codex agent 安装路径仍只写 role 文件，不写 `[agents.<roleKey>]` 注册项，也没有把注册项和 role 文件作为一个逻辑 artifact 跟踪：
  - `packages/cli/src/adapters/codex.ts:1599-1608`
- 当前 user scope agent 可见性诊断确实还是按 `agents/*.toml` 文件名收集，再做字符串比对；spec 这次已经把这个缺口明确收掉：
  - `packages/cli/src/utils/detect.ts:241-302`
  - `packages/cli/src/utils/detect.ts:470-481`

所以结论不是“实现很轻”，而是“方向对，改造点明确，当前基线有足够支点承接”。

### 3. 上一轮报告问题是否还有尾巴

上一轮报告提的两条问题，这轮已经都处理到位，没有再看到衍生问题：

- 共享 `.codex/config.toml` 的事务边界，现在已经从“建议”变成了明确 contract。
- user scope 下 higher-priority layer 的 role 可见性诊断，现在也已经被明确要求按最终 role 名空间解析。

我这次没有再发现因为修这两条而引入的新问题。

## 剩余风险与实现注意点

这部分不是 spec 缺陷，但实现时建议盯紧：

- 这次会新增 manifest/schema、tracking 结构和 Codex adapter 行为。按仓库约定，`.agents/skills/create-agent-workflows-plugin/`、`docs/plugin-authoring.md` 和 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md` 需要在同一轮同步更新，不能只改 runtime contract。
- 测试重点建议放在四类场景：`aw status` 只读约束、最终 role 名空间冲突与遮蔽诊断、user scope render config 不吸入 project config、config-triggered refresh 的回滚与失败诊断。

## 结论

当前这版 `docs/dev/specs/codex-explorer-plugin-spec.md` 已经没有我认为需要继续回炉的 spec 级问题。

需求方向合理，逻辑闭环完整，也能在当前基线上落地。接下来可以进入实现拆分和测试设计阶段，不需要再因为上一轮 review 的问题卡住。
