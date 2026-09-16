import { parseClaudeCodeTranscript } from "agent-session-format";
import type { Transport } from "../transport/types.ts";
import type { FileGroup, Reader, ScanEvent } from "./util.ts";
import { readTextVia, stableRev } from "./util.ts";

export class ClaudeCodeReader implements Reader {
  readonly family = "claude-code";

  async *scan(transport: Transport, group: FileGroup): AsyncGenerator<ScanEvent> {
    for (const file of group.files) {
      try {
        const text = await readTextVia(transport, file);
        const session = parseClaudeCodeTranscript(text, { source: group.toolId, filePath: file });
        if (!session) continue;
        const rev = await stableRev(transport, file);
        yield { kind: "session", sourceFile: file, rev, session };
      } catch (err) {
        yield { kind: "issue", path: file, error: String(err) };
      }
    }
  }
}
