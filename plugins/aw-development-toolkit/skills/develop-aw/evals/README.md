# develop-aw Eval

本目录使用 Selected Cases v1 / Manifest v1。所有 suite 的被测对象为 `develop-aw`，profile 提供 AW 与通用方法的实际依赖。当前共 51 个 case，模型状态为 **NOT_RUN**；正式运行前须通过公开 parser、独立 Oracle 审核和执行授权。

| Suite | 用例 | 数量 |
| --- | --- | ---: |
| `trigger` | [trigger-cases.json](trigger-cases.json) | 9 |
| `diagnostic` | [diagnostic-cases.json](diagnostic-cases.json) | 2 |
| `source-routing` | [source-routing-cases.json](source-routing-cases.json) | 8 |
| `review-materialization` | [review-materialization-cases.json](review-materialization-cases.json) | 9 |
| `review-diagnostic` | [review-diagnostic-cases.json](review-diagnostic-cases.json) | 2 |
| `integration-trigger` | [integration-trigger-cases.json](integration-trigger-cases.json) | 10 |
| `simplify-source` | [simplify-source-cases.json](simplify-source-cases.json) | 4 |
| `method` | [method-cases.json](method-cases.json) | 7 |

触发覆盖 AW 插件与 Skill 的分析、创建、修改、评审协作、简化协作及 Portable 导出；独立标准包和只执行已有 Spec 保持反例。expectedLoad 只表示是否采用该能力，不规定首次入口，也不关闭其他合法能力。显式请求名称不证明实际加载，加载需真实注入或文件读取证据。

AW 来源、物化和组合场景由本插件维护，详见[集成说明](integration-README.md)。通用 Reviewer、Simplifier 与 Auditor 仍负责各自的方法判断；本目录评价 AW 事实、操作选择、来源与权限边界。Oracle 尚未独立审核，模型结果尚未取得。

七个方法场景的前提、产物和验证边界见[方法用例说明](method-README.md)。CLI 测试替身只证明受控路由、实际文件与权限边界；生产物化由真实 CLI 测试验证，模型行为另行运行。suite/profile 的运行选择以 [manifest.json](manifest.json) 为准。
