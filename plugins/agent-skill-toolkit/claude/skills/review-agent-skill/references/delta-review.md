# Delta Review

只检查：

- 旧 critical/major finding 是否由当前材料真正关闭；
- 本次变更实际影响的职责、触发、规则和资源；
- 相邻正负例、直接回归和已知消费者；
- `SKILL.md`、branch、reference、script 和 Eval 资产的净变化；
- complexity 是 smaller、neutral 还是 larger。

没有新的 observed、normative 或 direct structural 证据时，不扩张新的高严重性 finding。修复某个具体 case 后，必须检查同族场景和最近的相反边界，避免局部过拟合。
