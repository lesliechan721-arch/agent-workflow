# Ask Me 作者期评测

这些用例分开检查自动发现和加载后的行为；确定性插件测试只验证语料结构、source contract 与双平台 bundle，不调用模型，也不能替代这里的行为评测。

## 触发语料

`trigger-queries.json` 固定包含 20 条用例：10 条正例和 10 条近似负例，train 12 条、validation 8 条。

- 正例覆盖模糊需求、冲突约束、不可行设想和显式调用。
- 负例覆盖完整规格、纯事实问答和只剩低风险细节的实现请求。
- 隐式用例在干净会话中各运行至少三次，先只根据 train 调整 description，再用 validation 检查泛化。
- `$ask-me` 与 `/ask-me` 用例检查手动入口和隐藏假设压力测试，不把宿主直接注入 skill 的结果计作隐式触发率。

## 行为评测

`evals.json` 包含三个多轮用例：先查后问并按回答重算前沿、挑战不可行需求，以及用户不知道或停止时保留未决风险。

每个用例分别在全新的 Codex 和 Claude Code 会话中运行：

1. `with_skill` 使用当前 `ask-me`；Codex 手动入口用 `$ask-me`，Claude Code 用 `/ask-me`。
2. `without_skill` 不加载该 skill，使用相同 prompt、仓库、权限和模型配置作为 baseline。
3. 按顺序发送 `scripted_replies`，保存完整工具轨迹、每轮问题、最终答复、duration、token usage（可用时）和运行前后的 workspace diff。
4. 按 `review.checks` 给出逐项证据。`workspace_unchanged` 必须通过；任何写文件、改配置或制作原型都判为失败。

当前仓库没有统一的跨平台模型 eval runner，因此这些会话需要由作者在对应客户端执行并保存证据。不要把 `pnpm plugin:test ask-me` 的通过结果报告成 Codex 或 Claude Code 的模型行为已经通过。
