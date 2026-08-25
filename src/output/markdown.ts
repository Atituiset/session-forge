import {
  aggregateByProject,
  aggregateByTime,
  blackholes,
  byModel,
  topFiles,
  totals,
} from "../analytics/index.ts";
import type { StoredSession } from "../store.ts";
import { formatTokens } from "./format.ts";

export function renderKnowledgeBase(
  rows: StoredSession[],
  granularity: "day" | "week" | "month",
): string {
  const t = totals(rows);
  const lines: string[] = [];
  const generated = new Date().toISOString().slice(0, 10);

  lines.push("# AI 开发历史知识库");
  lines.push("");
  lines.push(`> 由 session-forge 生成于 ${generated}，数据全部来自本地 Agent Session。`);
  lines.push("");

  lines.push("## 总览");
  lines.push("");
  lines.push(`| 指标 | 数值 |`);
  lines.push(`|:---|---:|`);
  lines.push(`| 会话总数 | ${t.sessions} |`);
  lines.push(`| 项目数 | ${t.projects} |`);
  lines.push(`| 用户交互轮次 | ${t.rounds} |`);
  lines.push(`| 代码变更 | +${t.additions} / -${t.deletions} |`);
  lines.push(`| Token 消耗(in/out) | ${formatTokens(t.tokensIn)} / ${formatTokens(t.tokensOut)} |`);
  if (t.cost > 0) lines.push(`| 费用估算 | $${t.cost.toFixed(2)} |`);
  lines.push("");

  const projects = aggregateByProject(rows);
  lines.push("## 项目维度");
  lines.push("");
  lines.push(`| 项目 | 来源 | 会话 | 变更 | Token(in) |`);
  lines.push(`|:---|:---|---:|---:|---:|`);
  for (const p of projects) {
    lines.push(
      `| ${p.project} | ${p.source} | ${p.sessions} | +${p.additions}/-${p.deletions} | ${formatTokens(p.tokensIn)} |`,
    );
  }
  lines.push("");

  const time = aggregateByTime(rows, granularity);
  if (time.length > 0) {
    lines.push(
      `## 活跃度（按${granularity === "day" ? "日" : granularity === "week" ? "周" : "月"}）`,
    );
    lines.push("");
    lines.push("```");
    const max = Math.max(...time.map((x) => x.sessions), 1);
    for (const b of time.slice(-30)) {
      const filled = Math.max(1, Math.round((b.sessions / max) * 40));
      lines.push(`${b.bucket}  ${"█".repeat(filled)} ${b.sessions}`);
    }
    lines.push("```");
    lines.push("");
  }

  const files = topFiles(rows, 20);
  if (files.length > 0) {
    lines.push("## 高频修改文件（AI 热点区域）");
    lines.push("");
    lines.push("| 文件 | 出现会话数 |");
    lines.push(`|:---|---:|`);
    for (const f of files) {
      lines.push(`| \`${f.file}\` | ${f.count} |`);
    }
    lines.push("");
  }

  const models = byModel(rows);
  if (models.length > 0) {
    lines.push("## 模型使用");
    lines.push("");
    lines.push(`| 模型 | 会话数 | Token(in) |`);
    lines.push(`|:---|---:|---:|`);
    for (const m of models) {
      lines.push(`| ${m.model} | ${m.sessions} | ${formatTokens(m.tokensIn)} |`);
    }
    lines.push("");
  }

  const holes = blackholes(rows, 5).slice(0, 15);
  if (holes.length > 0) {
    lines.push("## 黑洞会话（技术债务候选，迭代 ≥ 5 次）");
    lines.push("");
    lines.push(`| 来源 | 会话 ID | 项目 | 轮次 | Token(in) |`);
    lines.push(`|:---|:---|:---|---:|---:|`);
    for (const h of holes) {
      lines.push(
        `| ${h.source} | \`${h.id.slice(0, 18)}\` | ${h.projectPath ?? "?"} | ${h.rounds} | ${formatTokens(h.tokensIn)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
