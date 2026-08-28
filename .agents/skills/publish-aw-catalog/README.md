# publish-aw-catalog

把一个 AW Catalog 发布到用户明确给出的 Git remote 和 branch。

本 Skill 只支持显式调用。它先运行会执行已提交插件 build code 的 preflight，展示 CLI 返回的 Workspace、source、版本、fetch/push 目标、tag、snapshot digest、plan ID 和 descriptor digest，再等待用户授权这一个精确身份。发布命令绑定该 descriptor digest；失败后不会重试同一 Catalog 版本或删除 attempt。
