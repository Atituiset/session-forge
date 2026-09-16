// The NIR model now lives in the shared `agent-session-format` package; this
// module only re-exports it so existing import paths keep working.

export type { NirMessage, NirRole, NirSession, NirTokenUsage } from "agent-session-format";
export {
  makeNirSession,
  nirMessageSchema,
  nirRoleSchema,
  nirSessionSchema,
  nirTokenUsageSchema,
} from "agent-session-format";
