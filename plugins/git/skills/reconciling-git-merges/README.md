# Reconciling Git Merges

合并两个开发分支时，同时处理文本冲突和更隐蔽的行为、契约或依赖冲突。

## 适合使用

- merge 出现冲突标记。
- clean merge 仍可能让双方行为无法同时成立。
- 两个分支修改了相同接口、状态模型或依赖关系。

## 工作方式

Skill 会先理解双方意图，再完成合并、运行与改动相称的验证，并说明为兼容双方做出的决定。

## 不适合使用

- fast-forward、already up to date 或明显独立的 clean merge。
- rebase 工作流。
- 用户没有授权进行 merge。

插件不执行 push。

主要指令见 [`SKILL.md`](SKILL.md)，评测材料见 [`evals/`](evals/)。
