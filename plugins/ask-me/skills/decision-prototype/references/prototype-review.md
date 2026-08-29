# Prototype Review

只有需要标准网页反馈时读取本文件。简单文案、单张图片或无需局部定位的示例优先直接展示。

## 反馈层级

1. 视觉选择题：2–4 个候选、`都不接受`、额外评论。
2. 引导式问题：围绕信息层级、主操作、风险和可删除内容。
3. 局部标注：DOM、图片、文本或流程节点。
4. 受控编辑：仅使用 Prototype 声明的 editable tokens。
5. 高保真：只有真实操作感受是决定依据时使用。

## Bundle

Prototype 目录可以包含：

```text
brief.md
prototype.json
artifact/
review/
feedback.json
verdict.md
```

创建并启动 Review Shell：

```bash
node scripts/create-review-bundle.mjs --prototype <prototype.json>
node scripts/serve-review-bundle.mjs --root <prototype-dir>
```

服务只绑定 `127.0.0.1`。反馈绑定 Prototype ID 和 revision，并写入 `feedback.json`。

## 标注

- HTML 关键元素使用 `data-prototype-id`。
- 图片使用归一化坐标。
- 文本和流程使用稳定 block/node ID。
- 新 revision 不自动继承无法重新定位的旧标注。

## 反馈结论

工具层可以使用：

- `accepted`：当前问题已有稳定结论；
- `revise`：方向可用，但需要修改当前 Prototype；
- `rejected`：当前候选空间不成立；
- `new-material-question`：反馈暴露了无法在当前 Prototype 内解决的更大问题。

这些值是网页与脚本的数据合同，不是 Skill 间的聊天返回协议。
