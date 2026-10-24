# 文件选择离线 fixture

`baseline.json` 固定 AW 文件选择协议 v1 的 29 个原始合成观察。空白值和空排除项使用 AW 的输入拒绝规则，其余观察按共同集合验证。

`oracle-reference/files.js` 是 npm `@steipete/oracle@0.21.4` 的 `dist/src/oracle/files.js` 原样副本。SHA-256 为 `03f4343ef69d5a4e84837c2136f0f528d6afc1e02635232e41e5489c612b0484`。许可证见同目录 `LICENSE`。`errors.js` 只提取同版本的 `OracleUserError` 和 `FileValidationError` 类，保留其原文；其余错误类、服务依赖和格式化模块不参与选择测试。测试依赖的 `fast-glob@3.3.3` 由插件的 scripts package 声明。

`oracle-select.mjs` 调用该真实选择模块的 `readFiles(..., {readContents:false, maxFileSizeBytes:0})`，不调用 Oracle CLI、模型或网络。可选参数是移动后的 `selection-api.mjs` 路径，先调用生产 Oracle 支持检查，再覆盖适配器的扫描完整性检查；它不计算第二遍选择集合。Windows 非空选择由生产检查明确拒绝，helper/custom 仍验证完整选择集合；单独的 Windows 测试观察未修改参考模块的已知 ignore 差异。`selection-api.mjs` 与 Guide 保持已登记的相对布局，使用字面 import 读取最终物化模块，测试进程不解析计算得到的模块名。测试参考副本不证明任意已安装 Oracle 版本兼容。实际安装的离线检查证据单独记录。

`custom-adapter.mjs` 消费 Adapter v5 JSONL 的首条 start 请求，使用请求内的公共入口并仅调用一次。它输出 ready(false)、closing 和 result 事件，记录模型边界的字面路径集合；helper 失败时不记录提交。`audit-reads.mjs` 记录实际打开的文件，验证公共 helper 只读取 ignore 正文。
