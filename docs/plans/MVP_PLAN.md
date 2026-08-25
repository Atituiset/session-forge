# SessionForge 实施计划 v1.1

> 需求来源：`AR.md`（需求分析 v1.0）+ 本机数据源实测盘点（见 AR.md 附录A）
> 状态：执行中
> 创建：2026-08-25

---

## 一、已锁定决策

| 决策点 | 结论 |
|:---|:---|
| 技术栈 | **TypeScript + Bun**（`bun:sqlite` 零原生依赖读 SQLite） |
| 分发形式 | **独立二进制**，Bun compile 在 Linux 交叉编译 Windows/macOS 产物 |
| 互操作方向 | **单向导出先行**（A→B），跑通后再做双向回导 |
| 首发转换链路 | **NIR → Codex 家族**（一个 writer 覆盖 codex/kimi/deepseek/codewhale 四工具） |
| 计划落盘 | `docs/plans/MVP_PLAN.md`（本文件） |

## 二、需求修订汇总（相对 AR.md）

### 新增需求

| ID | 内容 | 优先级 |
|:---|:---|:---:|
| DI-10 | 跨平台路径注册表（Linux/macOS/Windows 三平台内置 manifest） | P0 |
| DI-11 | 启发式探测未知 Agent（签名指纹：`session_index.jsonl`、SQLite schema、JSONL role 特征） | P1 |
| DI-12 | 版本漂移容忍（读写双向适用，schema 变化降级不崩溃） | P1 |
| DIST-01 | 单二进制开箱即用，免装运行时 | P0 |
| IO-01 | Session 导出为其他 Agent 格式（单向） | P1 |
| IO-02 | 万能 Markdown 交接文档（任何 Agent 可消化的保底方案） | P0 |
| IO-03 | 工具调用语义映射（规范动词 read/write/edit/bash/search ↔ 各家命名） | P1 |
| IO-04 | 保真度分级标注（L1 对话交接 / L2 含工具调用重建 / L3 目标工具可直接 resume），转换产物声明达到层级 | P1 |
| IO-05 | 双向互通（二期） | P2 |
| DI-13 | **传输抽象层 Transport**：统一 `local` / `wsl:<distro>` / `wsl-windows-host` / `ssh:<host>` 四种数据访问方式，Reader 只面向 Transport 编程 | P0 |
| DI-14 | **WSL 双侧探测**：WSL 内自动探测 `/mnt/c/Users/*` 下 Windows 侧 Agent 数据；Windows 上经 `wsl.exe` 枚举发行版探测 Linux 侧 | P1 |
| DIST-02 | **SSH 远程扫描**：`scan --remote <host>` 将自身二进制自举到远端执行 `scan --json`，以 NDJSON 拉取结果入库；仅使用既有 SSH 密钥认证，不存储密码 | P1 |
| NF-07 | **SQLite 隔离约束**：SQLite 类 Reader 禁止通过 UNC/mnt 共享路径打开，必须在数据所在侧经 Transport 执行读取（防 9P/UNC 锁损坏） | P0 |

### 调整

- DI 层按"格式家族"而非按工具写适配器（附录A 实测结论：Codex 家族四工具同构）
- MVP 不做 Cline/Roo/Kilo/Continue/Aider 等 VSCode 扩展类及本机未装机工具
- PE-06/07 LLM 增强为可选联网功能，离线自动降级规则引擎（守住 NF-01 本地优先）

## 三、架构与目录

```
数据流：
readers/* → NIR(zod schema) → ┬ analytics → output/{terminal,markdown,json}
                              ├ enrich（本地增强）→ llm_enrich（可选联网）
                              └ writers/* → 目标 Agent 格式

session-forge/
├── package.json / tsconfig.json / biome.json
├── src/
│   ├── cli.ts                # scan/report/export/blackholes/profile/convert/handoff
│   ├── nir/schema.ts         # 中间表示：完整保留 tool_use/tool_result 配对+时间戳+tokens
│   ├── registry.ts           # DI-10 三平台路径清单（内置 manifest，含 WSL 双侧 overlay）
│   ├── transport/            # DI-13 数据访问抽象
│   │   ├── types.ts          # Transport 接口：readTextFile/listDir/exec/capabilities
│   │   └── local.ts          # 本机实现（P1）；wsl.ts / ssh.ts 于 P4.6
│   ├── discovery.ts          # DI-00 探测 + DiscoveryReport（按 Transport 枚举候选路径）
│   ├── readers/
│   │   ├── base.ts           # Reader 协议：signatures()/detect()/iterSessions()
│   │   ├── codex_family.ts   # 一读四：codex/kimi/deepseek/codewhale
│   │   ├── claude_code.ts    # 处理 isSidechain 子代理消息
│   │   ├── opencode_sqlite.ts# bun:sqlite 只读 + WAL 安全
│   │   ├── antigravity.ts    # transcript.jsonl 降级解析（P8 收尾）
│   │   └── generic_jsonl.ts  # DI-11 启发式兜底
│   ├── writers/
│   │   ├── codex_rollout.ts  # P7 首发：一写四，含 ID/时间戳再生
│   │   ├── claude_code.ts    # 自包含 JSONL
│   │   └── handoff_md.ts     # IO-02 万能兜底（P4.5）
│   ├── mapping/tools.ts      # IO-03 工具动词映射表
│   ├── enrich/               # 会话切分/角色分离/文件提取/diff统计/token统计/迭代轮次
│   ├── llm_enrich/           # 意图分类+决策摘要（Anthropic SDK，可选）
│   ├── analytics/            # 项目/时间/文件热点/黑洞聚合
│   ├── store.ts              # 本地缓存 SQLite，增量处理（NF-02）
│   └── output/               # 终端表格（自绘）/ Markdown 模板 / JSON
├── tests/
│   └── fixtures/             # 各家族真实数据脱敏快照
└── docs/plans/MVP_PLAN.md    # 本文件
```

## 四、分阶段执行与验收

| 阶段 | 内容 | 验收 |
|:---:|:---|:---|
| **P0** ✅ | 落盘本计划；补齐 AR.md 附录A；Bun 骨架 + lint/typecheck/test；冒烟验证 bun compile + bun:sqlite 打包 | `bun test` 通过，冒烟二进制可编译运行 |
| **P1** | registry + discovery + 三大 reader（Codex族/Claude Code/opencode）+ 去重(DI-08) + 损坏容忍(DI-09) → `scan`；Transport 接口定义并实现 `local`（DI-13），WSL Windows 侧探测(DI-14)随注册表落地 | 本机扫出全部 7 工具及数量；WSL 内可发现 `/mnt/c` 侧数据；空机器优雅报告 |
| **P2** | PE 本地增强全套（切分/角色/文件/diff/token/轮次） | 每家族 fixture 单测覆盖 |
| **P3** | 增量缓存 + AA 聚合 + 终端报表 → `report` / `blackholes` | 达成 S-02、S-03 |
| **P4** | `export` markdown/json | 达成 S-04 |
| **P4.5** | NIR 补齐 round-trip 所需字段 + `handoff_md.ts` → `handoff` 命令 | 任一 session 可产出交接文档 |
| **P4.6** | 远程与跨环境扫描（DIST-02/DI-13 完整落地）：`ssh.ts`/`wsl.ts` Transport、二进制自举、`scan --remote <host>` | 从本机索引到另一台 Linux/Windows 主机及 WSL 发行版的 session（S-09） |
| **P5** | LLM 意图分类/决策摘要（显式开启，离线自动降级） | 离线模式零报错（NF-01） |
| **P6** | Bun compile 三平台×双架构矩阵 + GitHub Actions release + Windows 实机验证（%APPDATA% 路径、CRLF、权限） | 干净 Windows 机解压即用（DIST-01/S-07） |
| **P7** | `writers/codex_rollout.ts`（一写四）+ `claude_code.ts` + `convert` 命令 + 保真度声明(IO-04) | 转换产物被 Codex CLI 识别并出现在 resume 列表（S-06） |
| **P8** | Antigravity/Cursor reader 收尾；双向互通（IO-05）预研与映射表设计 | 设计文档产出 |

## 五、关键风险与对策

| 风险 | 对策 |
|:---|:---|
| opencode.db 被运行中的 agent 锁定 | `mode=ro` 只读连接 + WAL 快照读，绝不写 |
| Codex rollout 内部 ID/版本校验 | writer 按 `cli_version` 建兼容矩阵；用真实 codex 实测 resume |
| Claude Code resume 识别条件苛刻 | 严格复刻 uuid/parentUuid 链与 sessionId；P7 用真实环境验证 |
| bun:sqlite 在 compile 产物中的兼容性 | P0 冒烟前置验证，不行则换 better-sqlite3 预编译方案 |
| Windows 平台差异 | P6 真机验证纳入 DoD，不接受"理论可行" |
| 双向转换信息丢失 | NIR 保留 raw_meta 透传 + lossy 标记，IO-04 明示 |
| SQLite 经 UNC/mnt 共享路径打开有锁损坏风险 | NF-07 强制：SQLite Reader 只经 Transport 在数据所在侧执行 |
| SSH 远端环境不可控（无 bun、架构不同） | 自举对应平台二进制（P6 矩阵产物）；远端仅需 `scan --json` 最小能力 |

## 六、成功标准（在 AR.md S-01~S-05 基础上新增）

- **S-06**：`convert` 产物在 Codex CLI 中可见且可 resume
- **S-07**：三平台二进制在无 Node/Bun 环境的干净机器上完成 scan
- **S-08**：全程本地优先，除显式开启的 LLM 功能外零联网
- **S-09**：`scan --remote <host>` 能索引 SSH 远端主机与 WSL 发行版中的 session，结果与本机数据合并入库
