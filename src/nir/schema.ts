import { z } from "zod";

export const nirRoleSchema = z.enum(["user", "assistant", "tool", "system"]);

export const nirTokenUsageSchema = z.object({
  input: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
});

export const nirMessageSchema = z.object({
  role: nirRoleSchema,
  content: z.string(),
  timestamp: z.string().nullable(),
  toolName: z.string().nullable(),
  toolInput: z.unknown(),
  model: z.string().nullable(),
  tokens: nirTokenUsageSchema.optional(),
});

export const nirSessionSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceVersion: z.string().nullable(),
  projectPath: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  messages: z.array(nirMessageSchema).min(1),
  rawMeta: z.record(z.string(), z.unknown()).default({}),
});

export type NirRole = z.infer<typeof nirRoleSchema>;
export type NirMessage = z.infer<typeof nirMessageSchema>;
export type NirSession = z.infer<typeof nirSessionSchema>;

export function makeNirSession(input: unknown): NirSession {
  return nirSessionSchema.parse(input);
}
