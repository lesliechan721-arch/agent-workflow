# 准备本次评审运行包

任务需要完整 final 且当前 inspection 未提供可用目标时读取。首次使用先读 `aw review prepare --help`；执行范围为当前 source 的必要依赖闭包、build/runtime imports 与所选平台渲染，输出到新隔离目录。

只读取证不要退回看似只读的命令：`plugin validate` 可能运行 renderer fixture，`plugin status` 可能准备 bundle，不能替代静态 inspection 或绕过准备授权。

## 选择与授权

固定目标、platform、scope 和影响内容的配置。已有明确配置沿用；默认配置由 CLI 从 manifest 校验。缺少必填配置或目标环境不唯一时，先补齐决定性输入。

完整审核请求涵盖本次必要的本地准备：先说明会执行插件 build/renderer 并生成隔离产物，再继续，不重复询问已有授权。严格源文件只读或禁止执行被审代码的请求保持 source-only。准备不赋予修改源码、安装到真实用户环境或运行模型的授权。

## 执行

典型调用以公开帮助为准：

```bash
aw review prepare <plugin-or-source-skill> --platform <platform> \
  --scope <scope> --out <new-directory> --json
```

配置覆盖需要时通过 `--config <file>` 传入；Plugin 中选择部分 Skill 时使用 `--skill`。用户未指定输出位置时，在可写且已规范化的系统临时根下选择新目录。准备与 Eval suite、用例和 grader 无关。

成功回执给出实际 `skills[].finalPath`、profile、digest 和 `sourceBindingPath`。使用这些路径审核；不要从源目录布局推断输出路径。回执验证覆盖本次生成内容，可直接开始 leaf review；稍后复用、源码/profile/依赖改变或产物发生变化时，通过 inspection 重新确认。

## 失败与交付

返回的错误说明配置、构建、渲染、资源或能力缺口。旧 v1 来源凭据通过对应准备入口重新生成，不修改凭据版本或手填 digest。源码设计可以继续独立评价；完整运行包结论保留未验证。修复请求转给 `develop-aw` 修改对应 source，再针对新产物审核。

评审只读生成的 final。结果中保留本次产物和来源路径；临时目录清理由用户指定位置和项目工具策略决定。构建函数、digest 与来源绑定算法由 CLI 管理。
