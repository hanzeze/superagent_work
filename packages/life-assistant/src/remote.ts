import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol';
const command = z.record(z.string(),z.unknown());
const snapshot = z.record(z.string(),z.unknown());
const result = z.object({ accepted: z.literal(true), id: z.string(), revision: z.number(), snapshot });
const emptyRequest = z.object({});

const subscription = z.discriminatedUnion('type',[
  z.object({ type: z.literal('open'), snapshot }),
  z.object({ type: z.literal('snapshot'), snapshot }),
  z.object({ type: z.literal('keepalive'), revision: z.number() }),
]);
const codec = (create: () => z.ZodType, jsonSchema: Record<string,unknown>) => ({ mode: 'strict' as const, typeSymbol: '@local/life-assistant#LifeRemoteValue', create, jsonSchema });
const objectSchema = { type: 'object', additionalProperties: true };
function direct(method: string, schema: z.ZodType, output: z.ZodType, description: string, stream = false) {
  return { service: 'life', description, invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', source: 'json' as const, codec: codec(() => schema,objectSchema), strictCodec: codec(() => schema,objectSchema) }], ...(stream ? { cancellation: { parameter: 'signal' as const } } : {}), result: codec(() => output,objectSchema) };
}
export const LIFE_REMOTE = createTypertRemoteInfo({ package: '@local/life-assistant', methods: {
  'life/snapshot': direct('snapshot',emptyRequest,snapshot,'Read the shared personal Work projection.'),
  'life/execute': direct('execute',z.object({ command }),result,'Persist and authorize one idempotent command.'),
  'life/cancel': direct('cancel',z.object({ id: z.string(), expectedRevision: z.number() }),z.object({ accepted: z.literal(true) }),'Independently request cancellation; this does not undo committed work.'),
  'life/subscribe': { ...direct('subscribe',emptyRequest,subscription,'Follow the same projection used by every channel.',true), mode: 'stream' as const },
}}, z);
export type LifeRemote = { snapshot(request: Record<string,never>): Promise<import('./contract.ts').Snapshot>; execute(request: { command: import('./contract.ts').Command }): Promise<import('./contract.ts').CommandResult>; cancel(request: { id: string; expectedRevision: number }): Promise<{ accepted: true }>; subscribe(request: Record<string,never>, signal?: AbortSignal): AsyncIterable<{ type: 'open'|'snapshot'|'keepalive'; snapshot?: import('./contract.ts').Snapshot; revision?: number }> & { return?: () => Promise<unknown> } };
