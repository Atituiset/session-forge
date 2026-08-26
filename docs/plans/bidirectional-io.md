# 双向 Session 互操作设计（IO-05，二期）

> 状态：R1–R3 已实施（R1 归一化矩阵扩展、R2 import 命令、R3 round-trip 基建）；实时同步不做
> 前置：单向导出已达成 S-06（NIR→Codex 实测可 resume）

## 1. 目标

在单向导出（A→B）跑通的基础上，支持把**外部 Agent 的原生 session 导入** session-forge 后再导出到任意目标——本质上是把 NIR 作为枢纽格式做 **B→NIR→A**。

## 2. 与单向版的差异

| 维度 | 单向（已实现） | 双向 |
|:---|:---|:---|
| Reader 输入 | 各家原始存储 | 同左（无变化） |
| Writer 输出 | NIR → 目标格式 | 不变 |
| 缺口 | 无 | **导入侧校验**：外部 session 可能含本机没有的字段/工具命名变体 |

因此双向的核心工作量不在传输，而在：
1. **工具命名归一化增强**：`mapping/tools.ts` 需覆盖更多家族变体（kimi/deepseek 的 toolCalls 字段形状、antigravity 的 CODE_ACTION 等）
2. **round-trip 损耗度量**：建立 fixture 矩阵（每家族 3 个真实样本），定义 `lossy` 标记的自动检测规则

## 3. 保真度损耗模型

| 信息类别 | L1（对话） | L2（+工具调用） | 已知不可恢复项 |
|:---|:---:|:---:|:---|
| user/assistant 文本 | ✅ | ✅ | — |
| 工具调用名/参数 | ❌ | ✅ 映射后 | 私有参数结构（如 codex internal metadata） |
| 工具输出 | 部分 | ✅ 截断 10KB | 超长输出 |
| token/cost 计量 | ❌ | ❌ | 目标格式多数不含 usage 行 |
| 思考链（thinking/reasoning） | ❌ | ❌ | 各家加密或私有格式（codex reasoning、opencode reasoning part） |

**结论**：双向永远达不到无损，产物必须带 `session-forge: converted, fidelity L2` 元数据标记（已实现于 convert 报告）。

## 4. 实施清单（预计 3 个阶段）

1. **R1 归一化矩阵扩展**
   - 为 kimi `toolCalls[]`、deepseek/codewhale `tool_calls[].function`、antigravity 事件补齐 canonicalize 规则
   - 新增 tests/mapping.test.ts 全量快照测试
2. **R2 导入命令**
   - `session-forge import <path> --from <format>`：绕过 discovery 直接解析单个文件入库
   - 用途：用户手动拷贝的别机 session 文件、团队分享
3. **R3 round-trip 测试基建**
   - `scripts/roundtrip.sh`：对每家族 fixture 执行 read→convert→read 断言消息数守恒 ≥95%
   - CI 中作为独立 job

## 5. 明确不做

- 加密类 session（如 Cursor 云同步数据）不计划支持
- 不尝试还原 thinking/reasoning 内容
- 不做实时双向同步（只做显式 convert/import）
