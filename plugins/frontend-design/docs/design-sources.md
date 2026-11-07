# Frontend Design 来源与取舍

以下记录供阅读和维护本技能时参考，不属于执行流程或运行依赖。原查阅记录日期：2026-10-15。`main` 链接会变化，维护时需重新核对适用内容；执行前端任务不要求读取这些上游材料，也不自动执行上游脚本。

### 设计方法参考

| 来源 | 本技能采用的判断 | 不直接继承的控制 |
| --- | --- | --- |
| [Anthropic Frontend Design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | 从主题、真实内容和受众选择视觉方向；排版、构图与表现重点相互支持 | 不把审美偏好、固定调色数量或特定排版禁例变成所有任务的硬规则 |
| [Taste Skill 旧版实验入口](https://github.com/Leonxlnx/taste-skill/blob/main/skills/taste-skill-v2-experimental/SKILL.md) | 先解释任务、区分保留与重做、检查依赖和状态；区分真实设计系统与风格借鉴 | 该入口自述为保留旧行为的实验版本，不能代表当前默认版本；不继承固定旋钮、默认框架、图标库、字体或调色禁用表 |
| [Emil Design Engineering](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md) | 按使用频率判断动效、及时反馈、空间来源、一致状态及中断体验 | 不要求统一 Before/After 格式、所有按钮缩放、所有键盘动作绝对禁动或固定库 API；性能与兼容性结论需要实际证据 |
| [Impeccable 主技能](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/SKILL.md) | 按页面用途区分表达与工作效率；保留既有视觉依据；条件读取；验证真实结果而非意图 | 不复制多命令入口、context 二进制、hooks、自动文档、候选抽选或固定检查轮次；保持一个可独立使用的技能 |

Impeccable 的相关分支包括 [new-work](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/new-work.md) 的保留、扩展与重做边界，以及 [craft-floor](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/craft-floor.md) 和 [operate](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/operate.md) 的检查对象与工作型界面判断。本技能不是上游的翻译、副本或命令兼容实现，不分发其脚本、字体、图像或模板。

### 规范与经验分开

对比度、重排和目标尺寸依据 W3C 的 WCAG 2.2 解释页；各主题 reference 在规则附近链接具体条款，保留级别、单位和例外。模态交互依据 WAI-ARIA APG 模式。解释页帮助理解，完整符合性仍以适用规范和实际覆盖为准。

字体选择、行长起点、间距尺度、表达强度和动效时长属于设计启发，不是通用标准。对第三方技能中的强制偏好、示例参数或简化性能解释，保留其适用判断，不推导成无条件限制。需要复用任何上游原文、代码或资产时另行核对其当前许可证与署名要求。

本技能采用单入口、无强制运行依赖、条件参考和证据边界；这些安排属于本技能自身的设计，不代表上游技能的原始合同。
