# Git Reconcile

协调 Git `merge`、`rebase` 与 `cherry-pick` 中的文本冲突与跨分支语义、契约或依赖交互。

## 适合使用

- `merge`、`rebase` 或 `cherry-pick` 出现冲突标记或处于进行中状态。
- 两个分支修改了相关接口、数据单位、状态模型或依赖关系，需要检查或协调组合行为。
- 显式调用以深度审计一次 clean merge 是否潜藏跨文件语义冲突。
- 只读分析分支合并风险并保持脏工作区不变。

## 工作方式

Skill 会结合共同祖先与双侧历史查明双方真实意图，识别文本冲突与隐蔽语义交互，做最小集成适配并验证组合结果，再按操作类型原子收尾（单个双父 merge commit，或沿原 rebase/cherry-pick 操作继续完成）。

## 不适合使用

- fast-forward、already up to date，或无冲突且无语义交互信号的常规 merge、rebase 与 cherry-pick。
- 普通本地提交（请显式调用 `git-commit`）。
- 未获授权的仓库修改或远程推送。

## 安全边界

- 绝不执行 `git push`。
- 保护无关本地修改，仅分析时不改变任何 refs、index 或 worktree。
- 双方业务规则冲突且缺乏依据时停止并报告待决问题，不自行拍板或发明折中方案。

主要指令见 [`SKILL.md`](SKILL.md)，评测材料见 [`evals/`](evals/)。
