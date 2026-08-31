# publish-aw-catalog

在用户清晰要求发布 AW Catalog 时发布它，包括“发布当前 Catalog”。普通修改、build、验证和只读 Review 不会触发本 Skill。

它把用户已明确给出的 root、remote 和 branch 传给首次 `aw catalog context`。Blocking marker issue 会停止；无效的显式 remote 或 branch 等 blocking publication issue 必须先取得更正选择并重新取得 context，不能进入 preflight 或复用旧 receipt。随后它运行会执行已提交插件 build code 的 preflight。在请求授权前，它展示最终绝对 root、Workspace identity、source HEAD、Catalog version、remote name、安全 fetch/push URL、branch、parent、tag、snapshot digest、plan ID 和 descriptor digest。用户精确授权完整 descriptor digest 后，发布命令显式传回 preflight receipt 的 root、remote、branch 和 digest；拒绝、失败、drift 或不确定结果都会停止。Catalog 不支持同版本重试或 repair。
