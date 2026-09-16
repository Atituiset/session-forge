import { parseCodexRollout, parseKimiWire, parseSessionJsonDocument } from "agent-session-format";
import type { NirSession } from "../nir/schema.ts";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import { readTextVia, stableRev } from "./util.ts";

export class CodexFamilyReader implements Reader {
  readonly family = "codex-family";

  async *scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      try {
        const session = await parseFile(transport, file, group.toolId);
        if (!session) continue;
        const rev = await stableRev(transport, file);
        yield { kind: "session", sourceFile: file, rev, session };
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      }
    }
  }
}

// Sub-formats dispatch by file NAME: .json → codewhale/deepseek session
// document, *wire.jsonl → Kimi Code wire stream, anything else → codex rollout.
async function parseFile(
  transport: Transport,
  file: string,
  toolId: string,
): Promise<NirSession | null> {
  const text = await readTextVia(transport, file);
  const opts = { source: toolId, filePath: file };
  if (file.endsWith(".json")) {
    // A corrupt document is an issue worth surfacing, not a silent skip.
    JSON.parse(text);
    return parseSessionJsonDocument(text, opts);
  }
  if (file.endsWith("wire.jsonl")) {
    return parseKimiWire(text, opts);
  }
  return parseCodexRollout(text, opts);
}
