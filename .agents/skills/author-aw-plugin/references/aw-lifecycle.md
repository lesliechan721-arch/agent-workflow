# AW Lifecycle

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。lifecycle 只处理安装、升级或卸载时必须发生的插件副作用；配置驱动的平台文件使用 dynamic artifact。

入口从 `AW_PLUGIN_CONTEXT` 读取事件、插件根、平台、scope、配置和允许路径。不要用 `process.cwd()`、真实 home 或固定仓库布局推断插件根。只访问 context 授权的路径。

脚本必须短、小、幂等：重复执行得到相同结果；创建前确保父目录存在；清理允许目标不存在；不改源码或 generated bundle；不删除不能证明属于本插件的内容。失败输出必须脱敏，并保留可重试或清理路径。

Node 示例：

```js
import { readFile } from 'node:fs/promises';

const contextPath = process.env.AW_PLUGIN_CONTEXT;
if (!contextPath) throw new Error('AW_PLUGIN_CONTEXT is required.');
const context = JSON.parse(await readFile(contextPath, 'utf8'));
```

运行测试前，从目标工作区的规则、package scripts 或 CI 发现真实入口；不要假设固定包管理器或命令名。
