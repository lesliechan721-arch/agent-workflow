# Plugin 与源 Skill Review

检查 Plugin source、manifest、依赖、共享脚本、runtime imports/exports、build 声明和 profile 差异。使用 inspection 的 review 视图定位实际 source 和 final；单 Skill 请求只取对应项及必要上下文。

## Leaf 交接

调用 `review-agent-skill` 时在当前上下文说明：实际 final root、已验证的 profile/digest、需要关注的设计问题，以及关联 source/build 声明和源 Eval 的位置。source-design 请求则明确仅评价可见源码。

包引用、生成内容和调用 metadata 在 final 上判断。源码声明注入的资源通过声明和实际 final 对照；源 Eval 不必出现在运行包中，按其原格式单独审查。

同一正文在不同 profile 下可能有不同 metadata、权限和运行要求；内容分析可复用，profile 结论分别覆盖。多 Skill 的结果不能直接平均成 Plugin 通过。

## Finding owner

先记录缺陷出现的 final/path/profile，再沿已有 manifest/runtime provider 映射确定权威 source 或构建规则。原材料未证明根因时，输出待定位而非要求修改某个 leaf。编辑属于后续授权的源码任务；本次 Review 保持被审对象不变。
