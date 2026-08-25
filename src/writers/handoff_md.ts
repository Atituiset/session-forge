import { enrichSession } from "../enrich/index.ts";
import type { NirSession } from "../nir/schema.ts";

const MAX_TEXT = 400;

export function renderHandoff(session: NirSession): string {
  const stats = enrichSession(session);
  const lines: string[] = [];
  const date = session.startedAt ? session.startedAt.slice(0, 10) : "unknown";

  lines.push("# Session Handoff");
  lines.push("");
  lines.push(
    `> 来源: \`${session.source}\` · 会话: \`${session.id.slice(0, 24)}\` · 日期: ${date}` +
      (session.projectPath ? ` · 项目: \`${session.projectPath}\`` : ""),
  );
  lines.push(
    "> 本文档由 session-forge 从原始 Agent 会话生成，供任何 AI 编码工具作为上下文接续使用。",
  );
  lines.push("");

  const userMessages = session.messages.filter(
    (m) => m.role === "user" && isRealUserText(m.content ?? ""),
  );
  if (userMessages.length > 0) {
    lines.push("## 任务目标");
    lines.push("");
    const goal = (userMessages[0]?.content ?? "").slice(0, 1500);
    lines.push(goal);
    if (userMessages.length > 1) {
      lines.push("");
      lines.push(`（后续共 ${userMessages.length - 1} 次追加指令，见下方时间线）`);
    }
    lines.push("");
  }

  if (stats.filesTouched.length > 0) {
    lines.push("## 涉及文件");
    lines.push("");
    for (const f of stats.filesTouched.slice(0, 40)) {
      lines.push(`- \`${f}\``);
    }
    if (stats.filesTouched.length > 40) {
      lines.push(`- …另有 ${stats.filesTouched.length - 40} 个文件`);
    }
    lines.push("");
  }

  const commands = collectCommands(session);
  if (commands.length > 0) {
    lines.push("## 执行过的关键命令");
    lines.push("");
    lines.push("```bash");
    for (const c of commands.slice(-15)) {
      lines.push(c.replace(/\n/g, " "));
    }
    lines.push("```");
    lines.push("");
  }

  if (stats.hasError) {
    lines.push("## 遇到过的错误类型");
    lines.push("");
    lines.push(stats.errorTypes.map((e) => `\`${e}\``).join(", "));
    lines.push("");
  }

  lines.push("## 对话时间线");
  lines.push("");
  let shown = 0;
  for (const m of session.messages) {
    if (m.role === "tool") continue;
    if (m.role === "assistant" && !m.content) continue;
    shown++;
    if (shown > 30) break;
    const label = m.role === "user" ? "**用户**" : "**AI**";
    const text = truncate(m.content, MAX_TEXT);
    lines.push(`${label}：${text}`);
    lines.push("");
  }
  if (shown > 30) {
    lines.push(`…（已省略后续 ${shown} 条消息）`);
    lines.push("");
  }

  const lastAssistant = [...session.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (lastAssistant) {
    lines.push("## 最后状态");
    lines.push("");
    lines.push(truncate(lastAssistant.content, 1200));
    lines.push("");
  }

  return lines.join("\n");
}

function collectCommands(session: NirSession): string[] {
  const out: string[] = [];
  for (const m of session.messages) {
    if (!m.toolName || !m.toolInput || typeof m.toolInput !== "object") continue;
    if (!/exec|bash|shell|command|run/i.test(m.toolName)) continue;
    const input = m.toolInput as Record<string, unknown>;
    const cmd =
      typeof input.command === "string"
        ? input.command
        : typeof input.cmd === "string"
          ? input.cmd
          : null;
    if (cmd) out.push(cmd);
  }
  return out;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function isRealUserText(content: string): boolean {
  const t = content.trim();
  if (t.length === 0) return false;
  if (/^<(environment_context|system|user_instructions|skills_instructions)/i.test(t)) return false;
  if (/^<\w+[\s>]/.test(t) && !t.includes(" ")) return false;
  return true;
}
