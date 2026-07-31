import { z } from "zod";

const Oid = z.string().regex(/^[a-f0-9]{40,64}$/);
export const ReadOnlyToolRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("context.search"), input: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(10) }).strict() }),
  z.object({ name: z.literal("context.read"), input: z.object({ eventIds: z.array(z.string().min(1)).min(1).max(50) }).strict() }),
  z.object({ name: z.literal("git.status"), input: z.object({}).strict() }),
  z.object({ name: z.literal("git.diff"), input: z.object({ fromOid: Oid, toOid: Oid.optional(), pathspec: z.array(z.string().min(1)).max(50).optional() }).strict() }),
  z.object({ name: z.literal("git.show"), input: z.object({ checkpointOid: Oid, path: z.string().min(1).optional() }).strict() }),
  z.object({ name: z.literal("git.log"), input: z.object({ startOid: Oid, maxCount: z.number().int().min(1).max(50).default(20) }).strict() }),
]);
export type ReadOnlyToolRequest = z.infer<typeof ReadOnlyToolRequestSchema>;
