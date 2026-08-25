export const INTENT_TAGS = [
  "bug_fix",
  "feature_add",
  "refactor",
  "question",
  "documentation",
] as const;
export type IntentTag = (typeof INTENT_TAGS)[number];

const RULES: [IntentTag, RegExp][] = [
  ["bug_fix", /\b(fix|bug|error|crash|failing|broken|regression)\b|修复|报错|错误|崩溃|排查/i],
  ["documentation", /\b(docs?|documentation|readme|mdbook|comment)\b|文档|注释|说明/i],
  [
    "refactor",
    /\b(refactor|cleanup|rename|reorganize|split|extract|migrate)\b|重构|清理|迁移|拆分/i,
  ],
  ["question", /^\s*(what|why|how|which|explain)|^(对比|为什么|是什么|怎么|如何|解释)/i],
];

export function ruleClassify(text: string): IntentTag {
  for (const [tag, re] of RULES) {
    if (re.test(text)) return tag;
  }
  return "feature_add";
}

export async function llmClassify(
  goalText: string,
  opts: { apiKey: string; baseUrl?: string; model?: string },
): Promise<IntentTag> {
  const base = opts.baseUrl ?? "https://api.anthropic.com";
  const model = opts.model ?? "claude-haiku-4-5";
  const prompt = `Classify this AI coding session into exactly one tag: bug_fix, feature_add, refactor, question, documentation.

Session summary:
"""
${goalText.slice(0, 2000)}
"""

Reply with ONLY the tag.`;
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`llm classify failed: ${res.status}`);
  const data = (await res.json()) as { content?: { text?: string }[] };
  const reply = (data.content?.[0]?.text ?? "").trim().toLowerCase();
  for (const tag of INTENT_TAGS) {
    if (reply.includes(tag)) return tag;
  }
  throw new Error(`unparseable llm reply: ${reply.slice(0, 50)}`);
}
