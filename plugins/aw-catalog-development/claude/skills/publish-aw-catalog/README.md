# publish-aw-catalog

在用户清晰要求发布 AW Catalog 时发布它，包括“发布当前 Catalog”。普通修改、build、验证和只读 Review 不会触发本 Skill。

它把用户已明确给出的 root、remote 和 branch 传给首次 `aw catalog context`。若 context 要求补充选择，它以完整显式参数重新取得 context，并丢弃旧 receipt。随后它运行会执行已提交插件 build code 的 preflight，展示最终绝对 root、remote、branch 和 descriptor digest，并等待用户仅授权这一次 identity。发布命令显式传回 preflight receipt 的四个字段和 descriptor digest；拒绝、失败、drift 或不确定结果都会停止。Catalog 不支持同版本重试或 repair。
