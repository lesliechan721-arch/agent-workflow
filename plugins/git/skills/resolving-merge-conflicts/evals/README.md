# resolving-merge-conflicts 评测

`trigger-cases.json` 包含 20 个固定路由用例，分为 train（12）和 validation（8）。它使用 `expected_loaded_skills` 精确区分：

- 正在进行的 merge/rebase 冲突 → `resolving-merge-conflicts`；
- 普通本地提交 → `git-commit`；
- 只解释标记、启动或中止操作、cherry-pick/revert 冲突 → 不加载这两个 Skill。

中央 trigger runner 只检查 Skill 路由，不执行真实冲突解决。

`behavior-cases.json` 包含 3 个只读 conversation 用例，比较 with-skill 和保留 `git-commit` 的 baseline：

- 合并兼容的两侧意图；
- 证据不足时先询问用户；
- 正确理解 rebase 中 ours/theirs 的角色。

这些用例不修改 `.git`，也不替代以后需要的专用可写 Git runner。

## 运行

```bash
pnpm plugin:test git
pnpm plugin:eval git --skill resolving-merge-conflicts --batch-name materialization --materialize-only
pnpm plugin:eval git --skill resolving-merge-conflicts --batch-name router-validation --suite router --split validation --runs 1
pnpm plugin:eval git --skill resolving-merge-conflicts --batch-name behavior --suite behavior
```

最后一条命令是局部调试运行，会按中央评测规则标为 incomplete；发布证据需要使用默认 runs 完成 release target。
