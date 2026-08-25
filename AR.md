好的，我来帮你输出一份完整的**需求分析文档**。这份文档既是你Vibe Coding的“施工蓝图”，也是你未来工具迭代的“设计纲领”。

---

# AI编程Session资产聚合工具 —— 需求分析文档

**文档版本**：v1.0  
**创建日期**：2026-08-24  
**项目代号**：SessionForge（铸造认知之锤）

---

## 一、项目愿景

> 将AI编程过程中产生的海量、碎片化、沉睡的Session对话记录，转化为可检索、可分析、可复用的**个人/团队认知资产**，让每一次与AI的交互都成为未来效率提升的燃料。

---

## 二、核心痛点

| 痛点编号 | 痛点描述 |
|:---:|:---|
| P1 | Session文件散落在`.cline/`、`.cursor/`、`.continue/`等多个目录，格式各异，无法统一查看 |
| P2 | 历史对话只能逐条翻阅，无法从宏观维度感知“我过去一个月主要在写什么”、“改哪个文件最多” |
| P3 | 成功的调试经验和失败的踩坑教训随对话沉没，无法被未来复用 |
| P4 | Token消耗和修改轮次散落各处，无法量化评估“哪个模型/哪个时段效率最高” |
| P5 | 多人协作时，无法共享和沉淀团队级别的AI交互智慧 |

---

## 三、目标用户画像

| 用户角色 | 核心诉求 | 使用频次 |
|:---|:---|:---|
| **独立开发者** | 复盘个人编码习惯、提炼Prompt模板、监控Token成本 | 每周1-2次 |
| **技术团队Leader** | 了解团队成员AI使用情况、发现技术债务集中区、优化团队工具链 | 每迭代/每月 |
| **AI工具研究者** | 分析大模型在不同场景下的行为模式、失败率、最佳实践 | 不定期深度研究 |

---

## 四、功能需求矩阵

### 4.1 数据接入层（Data Ingestion）

> **核心设计原则**：不按"工具"写适配器，而按**格式家族**（Format Family）写适配器。
> 实际扫描发现，主流 Agent CLI 的存储格式高度趋同（Codex 系 JSONL、SQLite 单库、事件流），一个家族适配器可覆盖多个工具。详见**附录A：本机数据源盘点**。

| 功能ID | 功能描述 | 优先级 |
|:---:|:---|:---:|
| DI-00 | **自动发现**：`scan` 时探测全部已知路径（见附录A），报告发现了哪些工具及可解析的 Session 数量 | P0 |
| DI-01 | **Codex 家族适配器**：覆盖 Codex CLI / Kimi Code / DeepSeek CLI / CodeWhale 等 `sessions/*.jsonl + session_index.jsonl` 格式 | P0 |
| DI-02 | **Claude Code 适配器**：读取 `~/.claude/projects/<slug>/*.jsonl`（含 sidechain/subagent 消息标记） | P0 |
| DI-03 | **opencode 适配器**：只读打开 SQLite（`session`/`message`/`part` 表），支持 WAL 模式并发安全 | P0 |
| DI-04 | **Gemini/Antigravity 适配器**：优先解析 `brain/*/logs/transcript*.jsonl`；`.pb` Protobuf 会话降级为元数据占位 | P1 |
| DI-05 | **Cursor 适配器**：CLI 版 `~/.cursor/projects`；IDE 版 SQLite（schema 无文档，按版本探测） | P2 |
| DI-06 | **通用 JSONL 兜底适配器**：对未知工具做启发式解析（识别 role/content/timestamp 字段） | P2 |
| DI-07 | 支持通过配置文件指定**自定义路径**与**自定义适配器** | P2 |
| DI-08 | 自动去重：同一会话的多次写入只保留一份完整记录（以 `source+id+最后写入时间` 为键） | P0 |
| DI-09 | **损坏容忍**：单条消息/单个文件解析失败不中断整体导入，记录到错误日志并跳过 | P0 |

**明确不做（Out of Scope, MVP）**：
- VSCode 扩展类（Cline/Roo/Kilo）：本机未安装，且依赖 IDE globalStorage 路径
- Continue.dev / Aider / Goose / Amp / Windsurf / Zed：本机无历史数据
- 以上均通过 DI-07 自定义配置或后续插件接入

### 4.2 数据解析与增强层（Parsing & Enrichment）

| 功能ID | 功能描述 | 优先级 |
|:---:|:---|:---:|
| PE-01 | **会话切分**：按时间间隔（默认1小时无交互）将连续对话切分为独立“任务单元” | P0 |
| PE-02 | **角色分离**：区分`user`（人类提问）、`assistant`（AI回复）、`tool`（工具调用） | P0 |
| PE-03 | **文件提取**：从对话中解析出AI修改/创建的所有文件路径 | P0 |
| PE-04 | **代码变更统计**：计算每个会话的`+行数` / `-行数` / `净变更` | P0 |
| PE-05 | **Token统计**：提取或估算每次对话的输入/输出Token数 | P0 |
| PE-06 | **意图分类**：调用LLM为每个会话打标签（`bug_fix` / `feature_add` / `refactor` / `question` / `documentation`） | P0 |
| PE-07 | **决策摘要**：调用LLM提取本次会话中的关键决策点（如“选择了什么技术方案”、“为什么放弃方案A”） | P1 |
| PE-08 | **迭代轮次统计**：记录一个任务单元内“用户提问→AI回复”的往返次数 | P0 |
| PE-09 | **错误模式检测**：标记会话中出现的报错类型及解决轮次 | P2 |

### 4.3 聚合分析层（Aggregation & Analytics）

| 功能ID | 功能描述 | 优先级 |
|:---:|:---|:---:|
| AA-01 | **项目维度统计**：按项目文件夹聚合，展示每个项目的会话数、代码变更量、Token消耗Top榜 | P0 |
| AA-02 | **时间维度统计**：按日/周/月聚合，展示编码活跃度、效率趋势图 | P0 |
| AA-03 | **文件热点分析**：统计哪些文件被AI修改次数最多（高频变更区域） | P0 |
| AA-04 | **意图分布分析**：展示`bug_fix` vs `feature_add` vs `refactor`的占比饼图 | P1 |
| AA-05 | **效率评估**：计算“成功率”指标（迭代≤3次就完成的会话占比） | P1 |
| AA-06 | **成本分析**：按模型/按项目统计Token费用估算 | P1 |
| AA-07 | **踩坑发现**：找出迭代次数最多（≥5次）的“黑洞会话”，标记为技术债务候选 | P0 |
| AA-08 | **Prompt模板挖掘**：从成功的会话中提取高频问题模式，生成可复用的Prompt建议 | P2 |
| AA-09 | **模型对比**：在同一项目/同一时间段内，对比不同模型（Claude-3.5 vs GPT-4o）的效率差异 | P2 |

### 4.4 知识输出层（Knowledge Output）

| 功能ID | 功能描述 | 优先级 |
|:---:|:---|:---:|
| KO-01 | **终端报告**：在CLI中直接打印聚合报表（表格+简易图表） | P0 |
| KO-02 | **HTML看板**：生成一个静态HTML页面，包含图表和筛选器 | P1 |
| KO-03 | **Markdown知识库**：将分析结果输出为Markdown格式的项目文档（如`AI_DEV_HISTORY.md`） | P0 |
| KO-04 | **JSON导出**：将结构化数据导出为JSON，供其他工具调用 | P1 |
| KO-05 | **记忆库注入**：生成一段可直接粘贴为AI System Prompt的“个人编码习惯摘要” | P1 |
| KO-06 | **知识图谱**：生成标签之间的关联图谱（如“`bug_fix`经常与`async`标签一起出现”） | P2 |

---

## 五、非功能需求

| 需求编号 | 需求描述 |
|:---:|:---|
| NF-01 | **本地优先**：所有数据处理在本地完成，Session数据不上传任何云端服务 |
| NF-02 | **增量处理**：支持增量更新，每次运行时只处理新增的Session，避免重复计算 |
| NF-03 | **可配置性**：支持通过`config.yaml`配置数据源路径、切分时间阈值、输出格式等 |
| NF-04 | **性能要求**：处理1000个Session（约50MB数据）的时间不超过10秒 |
| NF-05 | **跨平台**：支持macOS / Windows / Linux |
| NF-06 | **开放扩展**：支持通过插件机制接入新的AI工具数据源 |

---

## 六、技术选型建议

| 层级 | 推荐技术 | 理由 |
|:---|:---|:---|
| 语言 | **Python 3.10+** | 数据清洗、文件处理、LLM API调用生态最成熟 |
| 数据处理 | **Pandas** | 会话数据的聚合、筛选、统计非常顺手 |
| 图表生成 | **Rich**（终端图表）/ **Plotly**（HTML看板） | Rich适合CLI报表，Plotly适合交互式可视化 |
| 配置管理 | **PyYAML** | 配置文件可读性强 |
| LLM调用 | **OpenAI / Anthropic SDK** | 用于意图分类和决策摘要（可配置使用本地模型如Ollama） |
| SQLite读取 | **sqlite3**（内置） | 读取Cursor的数据库 |
| 输出格式 | **Markdown + Jinja2模板** | 生成漂亮的知识库文档 |

---

## 七、用户交互流程（CLI命令设计）

```bash
# 初始化配置
session-forge init

# 扫描所有已配置的数据源，加载Session
session-forge scan

# 生成当前项目的聚合报告（终端输出）
session-forge report --project ./my-app

# 生成HTML看板
session-forge dashboard --output ./reports/

# 导出知识库Markdown
session-forge export --format markdown --output ./knowledge/

# 查看“黑洞”会话（高迭代次数）
session-forge blackholes --threshold 5

# 生成个人编码习惯摘要（可直接给AI用）
session-forge profile --output my_coding_profile.md
```

---

## 八、数据模型（核心实体）

```python
# 简化的数据模型示意

@dataclass
class Session:
    id: str
    source: str              # 'cline' | 'cursor' | 'continue' | 'claude_code'
    project_path: Path
    start_time: datetime
    end_time: datetime
    messages: List[Message]
    files_touched: List[Path]
    total_additions: int
    total_deletions: int
    total_tokens_in: int
    total_tokens_out: int
    iteration_rounds: int
    tags: List[str]          # 由LLM分类生成
    decision_summary: str    # 由LLM提取
    has_error: bool
    error_types: List[str]

@dataclass
class Message:
    role: str                # 'user' | 'assistant' | 'tool'
    content: str
    timestamp: datetime
    tool_name: Optional[str]
    tool_input: Optional[dict]
```

---

## 九、成功标准（MVP验收条件）

| 标准编号 | 验收条件 |
|:---:|:---|
| S-01 | 能成功读取并解析至少一种AI工具（Cline或Cursor）的本地Session |
| S-02 | 能在终端输出一份聚合报告，包含：总会话数、总代码变更行数、高频修改文件Top5 |
| S-03 | 能识别并列出迭代次数≥5次的“黑洞会话” |
| S-04 | 能生成一份可读性良好的Markdown知识库文档 |
| S-05 | 整个过程无需联网上传数据 |

---

## 十、后续迭代方向（Nice to Have）

- 支持团队协作模式：多人的Session可以聚合到同一看板
- 支持接入本地Ollama模型进行分类，降低LLM API成本
- 支持VSCode插件形式，在编辑器内直接查看分析结果
- 支持与Notion/Obsidian等知识管理工具同步
- 支持自动生成PRD/技术设计文档（从多轮对话中提炼需求演变过程）

---

## 附录A：本机数据源盘点（2026-08-25 实测）

> 对开发机（Linux）实际扫描的结果，作为接入优先级的事实依据。实施计划见 `docs/plans/MVP_PLAN.md`。

### A.1 有 Session 数据、可解析（按数据量排序）

| 工具 | 数据路径 | 格式 | 实测规模 | 适配器 |
|:---|:---|:---|:---|:---:|
| **opencode** | `~/.local/share/opencode/opencode.db` | SQLite（drizzle schema：`project`/`session`/`message`/`part` 表） | 1119 sessions / 14.7k messages / 61k parts | DI-03 |
| **Claude Code** | `~/.claude/projects/<project-slug>/*.jsonl` | JSONL，行含 `type`/`message`/`uuid`/`parentUuid`/`isSidechain`，目录名即项目路径 slug | 156 个文件 | DI-02 |
| **Codex CLI** | `~/.codex/sessions/**/*.jsonl` + `session_index.jsonl` | JSONL，首行 `session_meta` 含 `cwd`/`cli_version`/`model_provider` | 38 个文件 | DI-01 |
| **Kimi Code CLI** | `~/.kimi-code/sessions/wd_*/*.jsonl` + `session_index.jsonl` | 事件流 JSONL（`metadata`/`runtime.set_binding`/`profile.bind`…），与 Codex 同构 | 已确认多项目 | DI-01 |
| **DeepSeek CLI** | `~/.deepseek/sessions/`（另有 `composer_history.txt`） | 与 CodeWhale 同族（`config.toml`+`audit.log`+`sessions/` 布局一致） | 已确认 | DI-01 |
| **CodeWhale** | `~/.codewhale/sessions/` | 同上 | 已确认 | DI-01 |
| **Gemini Antigravity** | `~/.gemini/antigravity-cli/conversations/*.pb`；`brain/<uuid>/.system_generated/logs/transcript{,_full}.jsonl` | Protobuf（难解析）+ JSONL transcript（可解析，作为降级源） | 已确认多个 brain 目录 | DI-04 |

### A.2 仅存配置/无对话历史（暂不接入）

| 工具 | 路径 | 现状 |
|:---|:---|:---|
| Cursor CLI | `~/.cursor/` | 仅 `cli-config.json` + `projects/`，本机无 IDE 级 SQLite（`~/.config/Cursor` 不存在） |
| Trae / Trae-CN / Qoder / OpenClaw | `~/.trae*` 等 | 仅 skills/配置目录，未发现 session 存储 |
| GitHub Copilot CLI | `~/.copilot/` | 仅 config/logs |
| Hermes / chelper / chatlog | `~/.hermes` 等 | 非编码 Agent 或无标准 session 结构 |

### A.3 关键结论

1. **格式家族化**：Codex 的 `session_index.jsonl + sessions/*.jsonl` 约定已被 Kimi Code、DeepSeek CLI、CodeWhale 沿用 → 一个适配器覆盖 4 个工具
2. **两大存储形态**：JSONL 文件流 vs SQLite 单库（opencode），Reader 接口需同时抽象"流式读取"和"表查询"
3. **项目归属信息普遍存在**：Codex 在 `session_meta.cwd`、Claude Code 在目录 slug、opencode 在 `project` 表 —— AA-01 项目维度统计可行
4. **Protobuf 是唯一硬骨头**：Antigravity 主对话在 `.pb` 中，MVP 用 transcript.jsonl 降级即可
5. **SQLite 必须只读打开**（`mode=ro` + WAL 兼容），避免锁住正在运行的 Agent

---

## 实施计划

本需求文档的落地执行方案（技术选型、分阶段计划、风险预案、验收标准）已迁移至：

**`docs/plans/MVP_PLAN.md`**（v1.1，2026-08-25）

关键决策摘要：TypeScript + Bun 技术栈；独立二进制分发（支持 Windows）；Session 单向互操作先行（首发 NIR → Codex 家族，一个 writer 覆盖四个工具）。
