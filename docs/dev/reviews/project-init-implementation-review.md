# 项目初始化实现复审报告

审查对象：`docs/dev/plans/project-init.md` 对应的当前实现代码  
复审时间：2026-04-22

## 总体结论

上一轮报告里指出的几项主要问题，这一轮大多已经修掉了：

- Codex 共享产物 `AGENTS.md` / `hooks.json` 现在会按 tracking manifest 中的剩余插件重新聚合，不再被单插件覆盖。
- `~/.codex/config.toml` 改成了保留原始 block、局部更新 `[marketplaces.*]` / `[plugins.*]`。
- `status` 已经是只读路径，并且会先输出平台检测，再按平台聚合同一批插件状态。
- `detect.ts` 已经补上“可执行文件是否存在”的判断，不再只靠目录存在与否推断平台可用。
- coverage 工具链也已经补齐，`pnpm test:coverage` 可以直接跑通。
- marketplace 镜像一致性、真实仓库插件 manifest 生成，这两项现在也有自动化校验了。

本轮执行结果：

- `pnpm test`：通过，4 个测试文件、23 个测试全部通过。
- `pnpm build`：通过。
- `pnpm test:coverage`：通过，整体覆盖率为 `Statements 88.01% / Branches 80.98% / Functions 97.45% / Lines 88.01%`。

但这版实现还不能算“严格按计划完成”。我这轮重新检查后，确认还剩 1 个高严重度问题、1 个中严重度问题；另外 Phase 5 的真实环境验证依然没有仓库内证据，测试覆盖也还有几个明显空洞。

## 主要发现

### 1. 高：`install / uninstall / upgrade` 没有校验 marketplace 所有权，会误改或误删外部同名插件

- 代码位置：
  - `packages/cli/src/adapters/codex.ts:131-158`
  - `packages/cli/src/adapters/codex.ts:228-253`
  - `packages/cli/src/adapters/codex.ts:286-325`
  - `packages/cli/src/adapters/claude.ts:261-320`
  - `packages/cli/src/adapters/claude.ts:427-470`
  - `packages/cli/src/adapters/claude.ts:499-535`
- 计划依据：
  - `docs/dev/plans/project-init.md:185-199`
  - `docs/dev/plans/project-init.md:218-231`
  - `docs/dev/plans/project-init.md:350-381`

现在两端 adapter 的原生插件生命周期操作，基本都是按“插件名”直接写入或删除：

- Codex `installPlugin()` 直接覆盖 `registry.plugins[pluginName]`
- Codex `uninstallPlugin()` 直接 `delete registry.plugins[pluginName]`
- Codex `upgradePlugin()` 只要插件名相同，就会把 `marketplace` 和 `version` 回写成 `agent-workflows`
- Claude 侧对 `settings.plugins.installed[pluginName]` 也是同样的处理方式

问题在于，`status()` 明明已经能识别“这条安装记录不属于 `agent-workflows` marketplace”，并给出 drift warning，但命令执行路径没有据此止损。只要存在同名插件：

- `uninstall` 会把外部 marketplace 的安装记录直接删掉
- `upgrade` 会把外部 marketplace 的记录直接改写成当前仓库这套 marketplace / version
- `install` 也会无条件覆盖现有记录

我本轮用临时 workspace 做了 Codex 复现：先手工写入

```toml
[plugins.git-commit]
marketplace = "vendor-market"
version = "9.9.9"
```

然后执行 `uninstall git-commit`，结果这条外部记录被整段删除。Claude 路径虽然我没有单独再跑一遍命令级复现，但代码分支是同样的“按插件名直接覆盖/删除”模式，风险一致。

这和计划里的“状态模型与所有权”不一致。计划已经明确要求：

- 原生 marketplace / plugin 状态是事实来源
- CLI 不维护第二份安装数据库
- 漂移只应该被识别和提示，不能静默篡改无关原生状态

当前实现会破坏这个边界，风险比普通 drift 更高。

### 2. 中：Claude 手写配置与生成配置发生值重叠时，权限会丢失，hooks 会重复

- 代码位置：
  - `packages/cli/src/adapters/claude.ts:94-141`
  - `packages/cli/src/adapters/claude.ts:164-231`
  - `packages/cli/src/adapters/claude.ts:346-379`
  - `packages/cli/src/adapters/claude.ts:404-422`
- 计划依据：
  - `docs/dev/plans/project-init.md:190-194`
  - `docs/dev/plans/project-init.md:350-362`

这轮虽然已经修掉了“整段覆盖 `settings.permissions` / `settings.hooks`”的问题，但新的合并策略仍然有一个值碰撞缺口：

- `permissions` 走集合并集
- `hooks` 走“手写 + 生成”直接拼接
- 手写项是否保留，靠“当前值减去 awGenerated 聚合值”来推断

这个策略在“手写值和生成值不同”时没问题，但一旦两者相同，就会出错。

我本轮做了本地复现，结果如下：

1. 用户原本手写了 `permissions.allow = ['git status']`，而插件也生成 `git status`
2. 执行安装后，`settings.permissions.allow` 里只会保留一份 `git status`
3. 再执行卸载时，这个 `git status` 会被一起删掉，用户原本的手写权限丢失

同样的值碰撞如果发生在 `hooks` 上，表现又不一样：

1. 用户已有一条和插件完全相同的 hook
2. 安装后会出现两条一模一样的 hook
3. 卸载后才恢复成一条

也就是说，这里还没有真正做到“保留手写配置的所有权”，只是把“非重叠值”保住了。对共享的 `.claude/settings.json` 来说，这仍然是一个明显的行为缺口。

现有测试只覆盖了“手写配置和生成配置不重叠”的场景：

- `packages/cli/tests/integration/cli.test.ts:228-300`

没有覆盖这类值碰撞回归。

## 是否严格按计划实现

结论：还不能算严格完成。

### Phase 1-4

如果只看仓库骨架、CLI 主链路和自动化测试基础设施，这几部分已经接近收口：

- marketplace 双镜像一致性已有校验：`packages/cli/tests/unit/manifest.test.ts:109-116`
- 真实仓库里的插件 source manifest 到双端 target manifest 的生成也有校验：`packages/cli/tests/unit/manifest.test.ts:116-128`
- 环境检测、四个命令、Codex 配置保留、Claude marketplace 物化、status 只读、coverage 链路，这些都已经落地

但上面两个剩余问题都直接碰到了计划里的核心约束：

- 第 1 个问题破坏了“状态模型与所有权”
- 第 2 个问题说明 Claude 的 `settings.json` 合并策略还不够稳

所以这版最多只能算“主体实现已完成，边界行为仍未收口”。

### Phase 5

Phase 5 依然没有看到可核验的仓库内证据。

计划要求的验证项包括：

- `docs/dev/plans/project-init.md:259-264`
  - Codex repo-local discovery
  - Claude `plugin marketplace add` + materialization
  - 双端手动加载并执行 `git-commit` skill
  - CLI 四个命令的真实环境验证
  - 自定义扩展双端生成验证

但当前仓库里我能找到的仍然只有计划、调研和评审文档，没有对应的 Phase 5 验证记录。自动化测试通过不等于这部分验收已经完成，所以如果按计划原文衡量，这一项仍然是未闭环状态。

## 测试覆盖情况

### 已覆盖

当前自动化测试已经覆盖到这些关键路径：

- `utils/manifest.ts` 的 source manifest 读取、路径校验、默认 Claude hooks 去重、双端 manifest 生成
- 两份 `marketplace.json` 的镜像一致性校验
- 真实仓库 `plugins/` 下插件的 target manifest 生成
- 生成器的双端输出、Codex execpolicy 生成、Claude hooks 渲染
- `detect.ts` 的 scope 识别和“目录存在但可执行文件不存在”分支
- CLI `install` / `uninstall` / `upgrade` / `status`
- Claude marketplace 物化刷新
- Codex `config.toml` 的无损保留
- 多插件共享产物聚合
- `--platform auto|both` 的关键分支

### 当前覆盖率

本轮执行 `pnpm test:coverage` 的结果：

- `Statements`: `88.01%`
- `Branches`: `80.98%`
- `Functions`: `97.45%`
- `Lines`: `88.01%`

这个数字已经不低，但还不能说明边界场景都被守住了。

### 还缺的关键覆盖

目前最值得补的回归测试有 4 类：

1. marketplace ownership 保护
   - 覆盖“同名插件来自外部 marketplace”时，`status` 应提示 drift，但 `install / uninstall / upgrade` 不应该直接接管或删除外部记录。
2. Claude 值碰撞场景
   - 覆盖“手写 permissions 与生成 permissions 相同”
   - 覆盖“手写 hooks 与生成 hooks 相同”
3. `user` scope 命令路径
   - 当前集成测试里的命令调用基本都走 `scope: 'project'`，还没有对 `user` scope 的安装、卸载、升级、状态读取做直接回归。
4. CLI 入口本身
   - 覆盖率报告里 `packages/cli/src/index.ts` 仍然是 `0%`，说明现在测试主要在直接调用命令函数，参数解析和 CLI 输出层没有自动化保护。

还有一个需要单独指出的事实：当前集成测试依旧主要依赖 `packages/cli/tests/fixtures/repo-template` 这个夹具仓库，而不是直接拿当前仓库根目录的 `git-commit` 插件跑完整生命周期。所以现在能证明：

- CLI 逻辑对“一个带扩展定义的测试插件”是通的
- 当前仓库真实插件的 manifest 生成是通的

但还不能直接证明“当前仓库里已经提交的 marketplace / plugin 定义，和 CLI 端到端生命周期完全一致”。

## 建议修复顺序

1. 先补 marketplace ownership 保护。对 `install / uninstall / upgrade` 增加 marketplace 归属校验，至少不能静默改写或删除外部同名插件。
2. 再修 Claude `settings.json` 的值碰撞所有权问题，避免手写权限丢失和 hooks 重复。
3. 补 2 条针对上述问题的集成回归测试。
4. 最后补 `user` scope 和 CLI 入口层测试；如果要按计划收口，再补 Phase 5 的真实环境验证记录。
