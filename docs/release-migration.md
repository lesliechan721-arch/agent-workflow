# 发布交接和回归矩阵

本文记录当前简化发布流程的交接边界。公开步骤和参数见 README 的[本地开发与发版流程](../README.md#本地开发与发版流程)。

## 当前发布边界

- 发布入口是 `release:status`、`release:target`、`release:prepare` 和 `release:publish`。
- source 和 target 改动先提交；`prepare` 从干净 HEAD 生成本地 prepared artifacts。
- `.release/prepared/` 是 gitignored、可删除的弱状态，不是 source 合同，也不提交。`.release/attempted.json` 是 gitignored 的本地安全门禁，不得手动删除。
- publish 先记录 attempted，再按 `Eval → CLI → Catalog` 发布启用的轴。
- 任一远端写入失败或结果不确定后，提升受影响 target。工具在 target digest 改变后处理旧 attempted marker；再重新 prepare 并发布新版本。没有恢复命令，也不续跑同一候选。

## 回归矩阵

| 风险 | 最低证据 |
|---|---|
| CLI target 更新同步两个 public package 与 workspace dependency | `prepared-release.test.ts` 的 package-version case |
| beta 与 stable 独立选择 CLI 和 Catalog 候选 | `prepared-release.test.ts` 的 independent candidates case |
| prepare 只产生可覆盖的本地 artifacts | `prepared-release.test.ts` 的 overwriteable ignored descriptor case |
| source、build、artifact 或远端候选在 publish 前变化 | `prepared-release.test.ts` 的 drift rejection case |
| 首次远端写入前消费候选，失败后拒绝同版本重试 | `prepared-release.test.ts` 的 attempted candidate case |
| Catalog-only 使用兼容的已发布 CLI train | `prepared-release.test.ts` 的 Catalog-only compatibility cases |
| Catalog 远端原子写失败后要求新版本 | `catalog-git-publisher.test.ts` 的 atomic failure case |
| Catalog channel 和 immutable tag 的正常发布 | `catalog-git-publisher.test.ts` 的 stable/beta publisher cases；`pnpm test:smoke:publish:catalog` |
| constructed prepared descriptor 的发布顺序与失败门禁 | `release-publish-entry-smoke.test.ts` |
| 本地 tarball 打包和安装 | `pnpm release:pack:cli`、`pnpm release:install:local` |

这些测试只验证公开行为、失败边界和发布产物。不要为本文添加静态 prose 测试。
