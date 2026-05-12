# `aw-tui-ux-optimization.md` 需求复审报告

审查对象：`docs/dev/specs/aw-tui-ux-optimization.md`  
复审时间：2026-05-12

## Findings

本次复审没有发现新的阻塞性需求漏洞。上一轮报告指出的两处关键缺口，这版 spec 都已经补上了：

- 安装/升级里的 required config 现在明确复用 `配置` 动作的 config write group 规则，而且要求整批只读预检先完成，再按 config store 和表单 identity 分组：`docs/dev/specs/aw-tui-ux-optimization.md:354-361`、`389`、`867-868`、`917-918`
- `cleanup` 现在被定义为统一的恢复评估与执行入口，但不再暗示“所有异常都必须自动恢复成功”；对无法安全自动恢复的场景，也明确要求输出阻断原因和人工处理建议：`docs/dev/specs/aw-tui-ux-optimization.md:475-476`、`485`、`955`

### 建议 1. `cleanup --plan --json` 最好从第一版开始带 schema version

这不是阻塞项，但现在补上成本最低，收益也很明确。

spec 已经对 `status --json.consoleItems` 的 V2 合同做了明确版本化：`docs/dev/specs/aw-tui-ux-optimization.md:20-23`、`665-677`。相比之下，新引入的 `aw cleanup --plan --json` 虽然要求输出稳定机器可读 schema，但还没有单独的版本字段：`docs/dev/specs/aw-tui-ux-optimization.md:493-503`。

这里的风险不是“当前文档不成立”，而是未来一旦需要调整 `plannedRemovals`、`wouldBackups`、`blockingReasons` 或 receipt 结构，CLI 很容易再次落入“公共 JSON 合同已经变了，但消费者只能靠字段猜版本”的老问题。

建议在首版就固定类似下面的合同：

```ts
{
  cleanupPlanSchemaVersion: 1;
  dryRun: true;
  force: boolean;
  removeConfig: boolean;
  // ...
}
```

这样后续如果计划结构扩展，不需要再补一次破坏性迁移说明。

## 结论

这版需求已经比上一轮收得更稳，核心合同也基本自洽：

- TUI 首页和 `status --json.consoleItems` 的数据边界已经写死，catalog-only 插件只进入 console 专用加载路径，不再混进默认 `status` 结果集：`docs/dev/specs/aw-tui-ux-optimization.md:22`、`643-655`
- 公开 `consoleItems` 合同和 TUI 页面模型已经拆开，`targetOptions`、图标、颜色、badge 不再污染稳定 JSON schema：`docs/dev/specs/aw-tui-ux-optimization.md:23`、`681-788`
- `uninstall` / `cleanup` / `remove-config` 的职责边界已经比上一轮清楚很多，尤其是 `cleanup --plan`、`--force`、`--yes`、`--dependency-index` 的组合关系已经写成了命令合同：`docs/dev/specs/aw-tui-ux-optimization.md:445-448`、`475-520`
- `所有平台`、重复安装、shared runtime takeover、required config 分组这些最容易在实现里跑偏的地方，也都已经补成了明确约束：`docs/dev/specs/aw-tui-ux-optimization.md:235`、`359-377`、`389`、`469-470`、`823-831`

我的判断是：

- 需求方向合理
- 当前文档没有再看到明显自相矛盾或会直接带来错误实现的高优先级漏洞
- 这轮可以进入实现拆分

## 落地评估

这份需求在当前基线上可以落地，但仍然是一次命令层、console 模型、controller、prompt/runtime 和公开 JSON 合同一起调整的改造，不是改几处文案就能收口。

当前已经确认的基线差距主要有这些：

- 首页仍直接读取 `statusCommand().consoleItems`，还没有 console 专用 loader，因此拿不到 catalog-only 插件：`packages/cli/src/commands/console.ts:145-149`、`packages/cli/src/commands/discovery.ts:1229-1240`
- controller 还是 `插件 -> 位置 -> 动作`，与 spec 要求的 `插件 -> 功能 -> 目标` 结构不一致：`packages/cli/src/commands/console.ts:936-965`
- 公开 console 模型还是旧的 `PluginConsoleItem` / `PluginConsoleAction` 体系，状态里仍有 `needsAction`、`partial`、`external`，动作里仍有 `openInstallWizard`、`repairInstall`、`cleanupRecovery`、`diagnoseCommand` 这类旧语义：`packages/cli/src/commands/console-model.ts:12-30`、`86-101`、`691-780`、`1016-1085`
- 默认 console driver 还是追加式输出，不是页面式重绘，所以 spec 里的“旧页面不持续堆叠”当前还没落地：`packages/cli/src/commands/runtime.ts:233-237`
- required config prompt 仍然是“按 `plugin + schema` 去重，再返回一个 `selectedScope`”，还没有实现 spec 要求的 config store 分组模型：`packages/cli/src/commands/console-wizard.ts:481-528`、`packages/cli/src/commands/runtime.ts:702-803`
- `uninstall` 入口还保留 `--force`，而 `cleanup` 还没有 `--plan` / `--remove-config`，并且当前仍只支持单插件、单平台、单 scope 目标：`packages/cli/src/index.ts:749-755`、`packages/cli/src/commands/cleanup.ts:61-66`、`135-141`
- `cleanup` 现在也还没有扩到 spec 要求的统一恢复入口范围：健康安装和可认领状态依旧会被直接拒绝：`packages/cli/src/commands/install-state-removal.ts:920-925`

但有一条上一轮实现层面的担心，现在已经不是问题了：

- `repair --takeover-shared-runtime` 的 flag 链路在当前代码里已经接通，`normalizeRepairCommandOptions()` 会保留 `takeoverSharedRuntime`，`repairCommand()` 也在消费 normalized options：`packages/cli/src/commands/options.ts:283-301`、`packages/cli/src/commands/repair.ts:1821-1889`

所以这轮的真实结论不是“需求还有大洞”，而是“需求基本已经收稳，接下来主要是实现量不小”。

## 更优方案

如果要把实现风险再压低一点，我建议沿着下面的顺序推进：

1. 先收命令合同。  
   先改 `uninstall` / `cleanup` / `remove-config` / `cleanup --plan` / 重复安装互斥预检，把 direct CLI 的行为边界钉死。

2. 再抽共享模型。  
   把 `config write group`、`PluginConsoleSummary`、`PluginConsoleFeatureSummary`、`PluginConsoleExecutableAction`、重复安装原因码这些公共语义先做出来，避免 controller、wizard、status JSON 各自维护一套。

3. 然后改 controller 和 loader。  
   把首页 loader 改成 console 专用路径，再把流程从 `插件 -> 位置 -> 动作` 换成 `插件 -> 功能 -> 目标`。

4. 最后处理交互外壳。  
   `b` / `q` / `Esc` 的稳定导航结果和 console driver 的页面式重绘都很重要，但放在命令合同与页面模型之后做，返工最少。

这个顺序和 spec 现有“先命令合同、后 summary/page model、再 navigation/rendering”的思路是一致的；我这里只补充一个建议：把 `cleanup --plan --json` 的 schema version 一起放进第一阶段做掉。

## 历次问题跟踪

上一轮报告里的问题，这次结论如下：

- “`status --json.consoleItems` 与 TUI 首页在 catalog-only 插件上的来源边界没定死”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:22`、`643-655`
- “`targetOptions` 混入公开 `consoleItems` schema”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:23`、`681-788`
- “安装/升级会在阻断预检之前进入配置流程”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:354-361`、`389`
- “安装/升级在 `所有平台` 下缺少 required config 的 store/group 规则”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:361`、`389`、`867-868`、`917-918`
- “`cleanup --plan` 与现有 flags 的组合关系没有写成稳定合同”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:493-503`
- “`cleanup` 作为统一恢复入口的表述容易被理解成必须自动修好所有异常”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:475-476`、`485`、`955`
- “direct `uninstall --remove-config` 的多 target config store 分组语义缺失”已修复：`docs/dev/specs/aw-tui-ux-optimization.md:514-519`

本轮没有新增阻塞性问题。当前还值得补的一项，是给新的 `cleanup --plan --json` 机器合同加上 schema version。
