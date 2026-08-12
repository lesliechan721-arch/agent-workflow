# Plugin Release Intents

每个 JSON 文件声明一个尚未发布的插件 production 变化。文件必须包含：

```json
{
  "schemaVersion": 1,
  "plugin": "ask-me",
  "bump": "patch",
  "summary": "调整需求澄清行为。"
}
```

使用 `pnpm plugin:change:add <plugin> --bump major|minor|patch --summary <text>` 创建文件。稳定发布前运行 `pnpm plugin:release:apply --all`；该命令更新源码 manifest version 并删除已消费的 intent。不要把开发构建 receipt 或生成 catalog 写入本目录。
