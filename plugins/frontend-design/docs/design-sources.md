# Frontend Design 来源与取舍

以下记录供阅读和维护本技能时参考，不属于执行流程或运行依赖。最近核对日期：2026-11-25。`main` 链接可能变化，维护时需重新核对适用内容；执行前端任务不要求读取这些上游材料，也不自动执行上游脚本。

### 设计方法参考

| 来源 | 本技能采用的机制与判断 | 不直接继承的耦合与控制 |
| --- | --- | --- |
| [Anthropic Frontend Design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | 高频 AI 视觉默认皮警戒；两阶段方向契约与写码前反默认自检；“把大胆花在一处”与临门减法；用户视角、主动动词与一致词义的界面文案 | 不把特定审美倾向变成覆盖用户 brief 的硬规定 |
| [Taste Skill](https://github.com/Leonxlnx/taste-skill/blob/main/skills/taste-skill/SKILL.md) | 按业务形态匹配视觉载体（场所与实体产品重实景、软件重真实产品界面、技术特效限技术/游戏/创意主题）；基于真实浏览器的结果核查 | 不继承 Stop hook、本地门禁脚本、固定单屏章节模板、外链搜图工具或固定框架要求 |
| [Emil Design Engineering](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md) | 动效频率表（100+/天与快捷键 0ms 禁动）；常规 UI `<300ms`、强 `ease-out`（默认避 `ease-in`）与退快于进；`scale(0.95)+opacity:0`、浮层 `transform-origin`、可中断用 `transition`、触屏 `@media (hover: hover) and (pointer: fine)`、Tooltip 连续悬停与拖拽避改父级继承 CSS 变量 | 不强制所有评审锁死统一 Before/After 表格、所有按钮一律缩放或绑定特定动画库 API；性能结论仍须实测 |
| [Impeccable 主技能](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/SKILL.md) | 4 种页面模式对立工程默认（说服、操作、阅读、作品）；展示/作品绿地页先方向确认再写码；4 种色彩策略与光照场景定明暗；Craft Floor 具象红灯与浏览器表面细节；停稳动画后的批量渲染核查与批量修复复验 | 不复制 20+ 子命令入口、二进制 launcher、hooks、强制 `PRODUCT.md`/`DESIGN.md`、随机抽选器或生图流水线；保持零运行依赖的单技能 |
| [Gemini Frontend Design](https://github.com/google-gemini/demolab/blob/main/skills/gemini-frontend-design/SKILL.md) | 新闻/博客/目录/工具/简历直出内容不套全屏 Hero；破除 `50/50` 分栏 Hero + 底部 KPI 条并补充正向首屏构图与首屏以下防塌陷；桌面单行导航、品牌权重、Hero 贴顶 `y = 0` 与吸顶滚动分离；按视觉角色计字体 ≤2（`tabular-nums` 替代第 3 套等宽字体）与正文 3 档默认字阶；禁用非交互装饰标签/方框（保留交互控件与真实业务/系统语义状态）、按钮墙、伪遥测装饰与空转循环；直白展示文案、禁猜外链图 URL/本机路径及桌面首屏以下实视口滚动检视 | 不继承 `generate_image` 专有工具耦合与默认生图倾向、英文标点/字数/首屏硬限（em-dash、`<=25 words`、`-0.05em`、一刀切 `<13px`）、仅限表格/API 的过窄状态白名单、无条件 `100dvh` 写法，以及文末重复 4 段式校验清单；上游采用 Apache-2.0 许可，本技能以自有表述提炼机制，不照搬原文 |

Impeccable 重点参考分支包括 [new-work](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/new-work.md)、[craft-floor](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/craft-floor.md)、[operate](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/operate.md)、[mode-persuade](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/mode-persuade.md) 与 [mode-read](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/mode-read.md)。本技能不是上游的翻译、副本或命令兼容实现，不分发其脚本、二进制、字体、图像或模板。

### 规范与默认启发分开

对比度、重排、最小目标尺寸、拖拽与手势替代及键盘可达性依据 W3C 的 WCAG 2.2 解释页，并在 [交互、动效与可访问性条款](../skills/frontend-design/references/interaction-and-motion.md) 中集中给出精确条款、级别、单位与例外；模态及复合控件行为依据 WAI-ARIA APG 模式。解释页用于执行判断，完整合规仍以适用规范与实测覆盖为准。

反模板红灯、展示字体警戒、字阶起点、行长区间、色彩策略与动效默认曲线属于**高杠杆默认启发**——它们在用户未指定的自由轴上生效，用于对抗模型默认平庸输出；一旦用户、brief 或既有设计系统明确指定了不同方向，以明确约束为准。复用任何上游原文、代码或资产时需另行核对其许可证与署名要求。

本技能采用单入口、零强制运行依赖、0 跳核心加 3 份单跳真分支参考和集中证据边界；这些架构取舍属于本技能自身设计，不代表上游技能的原始合同。
