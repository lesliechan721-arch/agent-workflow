# 可选机器 Release Check

只在用户明确请求时使用；普通 Quality Review 不以此为完成条件。使用本 Skill 的 `scripts/check-aw-release.mjs --help` 核对已安装入口，再运行：

```bash
node <skill-root>/scripts/check-aw-release.mjs --target <plugin-or-workspace> \
  --evidence <aw-review-evidence.json> --materialization <aw-source-binding.json> \
  --eval-chain <chain.json> --format json
```

`--materialization` 和 `--eval-chain` 可重复；没有对应输入时省略。每个 chain 文件只包含 `spec`、`audit`、`result` 路径，相对路径从该文件所在目录解析。默认结果写 stdout；需要文件时用 `--output <new-file>`，覆盖须明确使用 `--overwrite`。检查不 build、不运行 Eval、不联网、不发布，也不修改目标。

## 证据与覆盖

先用 `aw review inspect <target> --json` 取得当前 inventory 和来源事实；提供现有绑定时附加 `--materialization`。Plugin 检查包含源码容器及每个适用 final leaf；Catalog 检查包含 Catalog 源码容器、全部当前插件与其 leaf。required Eval 只来自当前 manifest 的明确声明；零 required 合法。缺少当前物化产物时为证据不足，不临时运行被审代码补齐。

按 `assets/aw-review-evidence.schema.json` 填写真实 Review 结论；`assets/aw-review-evidence.template.json` 仅为形状示例，零摘要不是证据。容器使用 inspection 的 source container digest；leaf 使用当前 final digest，并映射到 workspace-relative logical source path。snapshot profile 使用平台与 scope；Eval/portable 变体使用 `{kind}:{id}:{scope}:{inputDigest}` 表示实际配置身份。同字节的不同语境仍分别覆盖。

每个 subject 单独填写 assessment、报告 evidenceRefs 与 blockingFindings。报告必须真实存在且文件摘要一致；不能把一个全局 pass 填成全部 leaf pass。单份报告确实覆盖多个对象时可复用内容证据。没有评审的对象使用 `not-assessed`。

checker 从当前 inventory 推导必需项，不信任 evidence 自报完整清单。Spec/Audit/Result 由官方 validator 验证，并通过当前来源绑定关联 target、workspace、prepared cases 和 provider。完整源 corpus 的 canonical 摘要不能与 prepared cases 文件的字节摘要直接比较。额外输入不能抵消缺项；没有预先比较政策时，不自行解释 baseline 为普遍无回归。

## 判定

只消费 checker 返回的主状态：`unsupported`、`invalid`、`blocked`、`incomplete` 或 `ready`，按此优先级合并原因。退出码分别为 2、2、1、3、0。未知或缺失证据不伪装为语义 blocker；已证实的必需对象缺陷或测试失败不能被其它通过项覆盖。

环境缺能力时报告缺口，不自制 ready。机器结果不授权 publication；按需归档时只作为已有报告的附件。
