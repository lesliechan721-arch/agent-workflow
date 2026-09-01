# AW postApply

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含 `aw.plugin-post-apply.v1` 时，才使用本合同。`postApply` 只处理每个 core target 成功 apply 和 verify 后的附加副作用；配置驱动的平台文件使用 dynamic artifact。

Manifest v3 只接受 Node 声明：

```json
{
  "scripts": {
    "postApply": {
      "path": "./scripts/postApply.mjs",
      "timeoutMs": 30000
    }
  }
}
```

脚本以 plugin root 为工作目录，用固定 Node 运行。脚本从 stdin 读取 JSON context v1。context 只含 plugin identity 和 root、target、effective config values，以及 component outcome。不得依赖平台 home、store path、artifact 内容或 `sourceIdentity`。

每次显式 reconcile 都运行，包括 no-op、root 和 dependency closure。失败或超时只产生 warning；core 结果保持成功，不回滚，也不保存失败状态。后续 `sync` 会再次运行。

脚本必须短、小、幂等：重复执行得到相同结果；创建前确保父目录存在；清理允许目标不存在；不改源码或 generated bundle；不删除不能证明属于本插件的内容。失败输出必须脱敏，并保留可重试或清理路径。

Node 示例：

```js
import { readFile } from 'node:fs/promises';

const context = JSON.parse(await readFile(0, 'utf8'));
```

运行测试前，从目标工作区的规则、package scripts 或 CI 发现真实入口；不要假设固定包管理器或命令名。
