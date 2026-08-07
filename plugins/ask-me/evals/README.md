# Ask Me 作者期评测

这些用例分开检查自动发现和加载后的行为；确定性插件测试只验证语料结构、source contract 与双平台 bundle，不调用模型，也不能替代这里的 Codex 行为评测。

中央入口会先 materialize 最终 project/user 制品。以下命令只生成制品，不启动模型：

```bash
pnpm plugin:eval ask-me --materialize-only --output-dir /tmp/ask-me-eval
```

本地发布评估运行 validation 触发 suite 和 app-server 多轮 behavior suite：

```bash
pnpm plugin:eval ask-me --output-dir /tmp/ask-me-eval
```

## 触发语料

`trigger-cases.json` 固定包含 20 条用例：10 条正例和 10 条近似负例，train 12 条、validation 8 条。中央 native trigger driver 负责干净会话、Skill 加载事件、重复运行、validation 零误触门槛和报告归档，插件不维护独立 runner。

- 正例覆盖模糊需求、冲突约束、不可行设想和显式调用。
- 负例覆盖完整规格、纯事实问答和只剩低风险细节的实现请求。
- 隐式用例在干净会话中各运行至少三次，先只根据 train 调整 description，再用 validation 检查泛化。
- `$ask-me` 与 `/ask-me` 用例检查手动入口和隐藏假设压力测试，不把宿主直接注入 skill 的结果计作隐式触发率。

## 行为评测

`evals.json` 包含四个会话用例：先查后问并按回答重算前沿、挑战不可行需求、用户不知道或停止时保留未决风险，以及显式调用面对完整规格时执行压力测试但不制造问题。

v1 每个用例分别在全新的 Codex app-server 会话中运行：

1. `with_skill` 使用中央 materializer 生成的当前 project `ask-me`。
2. `without_skill` 不加载该 skill，使用相同 prompt、仓库、权限和模型配置作为 baseline。
3. app-server driver 把 `scripted_replies.answers_by_index` 映射到运行时 question id，保存完整事件、每轮问题、最终答复、duration、token usage（可用时）和 workspace diff。
4. 按 `review.checks` 给出逐项证据。`workspace_unchanged` 必须通过；任何写文件、改配置或制作原型都判为失败。

`evaluation.json` 在机械检查完整后把 behavior 标记为 `needs_review`；由 repo-local `skill-review` 读取 suite report，对 `review.checks` 逐项判分。这里不使用第二个 judge 模型。Claude 模型行为暂不在 v1 范围内，不能把 Codex 或 `pnpm plugin:test ask-me` 的结果报告成 Claude 行为已通过。
