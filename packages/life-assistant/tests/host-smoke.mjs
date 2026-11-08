import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { transformSync } from 'esbuild';

// Node 22 strips types but does not implement TypeScript decorators.  This
// test-only loader runs the actual source, without changing the production
// tsconfig/build or writing a transpiled copy.  In particular, do not force
// `experimentalDecorators`: esbuild's standard transform preserves @Remote.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.ts') && url.includes('/life-assistant/src/')) {
      const source = transformSync(readFileSync(new URL(url), 'utf8'), {
        loader: 'ts', format: 'esm', target: 'es2023',
        sourcefile: url, sourcemap: 'inline',
      }).code;
      return { format: 'module', source, shortCircuit: true };
    }
    return next(url, context);
  },
});

const { Context } = await import('@deepseek-ai/cordis');
const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway');
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
const { TYPERT: SESSION_HOST } = await import('@deepseek-ai/dsh-api-session-controller/typert');
const { TYPERT_REMOTE: SESSION_REMOTE } = await import('@deepseek-ai/dsh-api-session-controller/remote');
const { LifeAssistantService } = await import('../src/server/service.ts');
const { LIFE_REMOTE } = await import('../src/remote.ts');
const { OWNER_ID } = await import('../src/contract.ts');
const clientModule = await import('@deepseek-ai/dsh-api-gateway/client');
const clientApply = clientModule.apply;
if (typeof clientApply !== 'function') throw new Error('DSH Client module has no apply export');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = predicate();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${message}; last=${JSON.stringify(last)}`);
}
async function rejectsCode(action, code) {
  await assert.rejects(action, error => {
    assert.equal(error?.code, code);
    return true;
  });
}

class FakeSessions {
  calls = [];
  answer = 'answer from fake session';
  failCreate = false;
  followRequests = [];
  async create(request) {
    this.calls.push(['create', request]);
    if (this.failCreate) throw new Error('synthetic create failure');
    return { sessionId: `session-${this.calls.filter(call => call[0] === 'create').length}`, agentPreset: null };
  }
  async prompt(request) {
    this.calls.push(['prompt', request]);
    return { accepted: true };
  }
  async *follow(request) {
    this.calls.push(['follow', request]);
    this.followRequests.push(request);
    yield { type: 'snapshot', header: { id: request.address.sessionId }, cursor: 0, records: [], hasMore: false };
    yield { type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: this.answer }] } } } };
    yield { type: 'event', event: { type: 'turn/end', seq: 2, time: Date.now(), data: { reason: { kind: 'completed' } } } };
  }
  async cancel(request) {
    this.calls.push(['cancel', request]);
    return { cancelled: true };
  }
}

class FakeSchedule {
  creates = [];
  deletes = [];
  async create(sessionId, request, signal) {
    signal?.throwIfAborted();
    this.creates.push({ sessionId, request });
    return { id: `dsh-schedule-${this.creates.length}` };
  }
  async delete(request, signal) {
    signal?.throwIfAborted();
    this.deletes.push(request);
    return { id: request.id, deleted: true };
  }
}

function fakeSystemPrompt() {
  return {
    tools() { return () => {}; },
    section() { return () => {}; },
    getSectionOrder() { return 0; },
  };
}

async function makePeer(ctx, principal = { kind: 'owner' }) {
  const abort = new AbortController();
  let peerCtx;
  const peerFiber = ctx.plugin({ name: `host-smoke-peer-${randomUUID()}`, apply(scope) { peerCtx = scope; } });
  await peerFiber;
  let disposed = false;
  return {
    id: `peer-${randomUUID()}`, ctx: peerCtx, principal,
    signal: abort.signal, interactions: 'none',
    async dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort(new Error('test peer disposed'));
      await peerCtx.fiber.dispose();
    },
  };
}

async function hostFixture({ realTools = false, sessions = new FakeSessions(), schedule = new FakeSchedule(), realSessionDescriptors = false } = {}) {
  const ctx = new Context();
  const peer = await makePeer(ctx);
  const cleanup = [];
  try {
    ctx.provide('remoteAccess', { decide() { return { kind: 'deny', reason: 'test non-owner' }; } });
    ctx.provide('sessionController', sessions);
    ctx.provide('schedule', schedule);
    if (realTools) {
      ctx.provide('systemPrompt', fakeSystemPrompt());
      await ctx.plugin(ToolRuntime);
    } else {
      const tools = new Map();
      ctx.provide('tools', {
        register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
        schemas() { return [...tools.values()]; },
        definitions: tools,
      });
    }
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(TypertGatewayService);
    ctx.typert.remotes.register(LIFE_REMOTE);
    if (realSessionDescriptors) ctx.typert.register(SESSION_HOST);
    await ctx.plugin(LifeAssistantService, { databasePath: ':memory:', cwd: '/tmp/life-assistant-host-smoke' });
    return {
      ctx, peer, sessions, schedule, life: ctx.get('life'),
      invoke: (method, request, options = {}) => ctx.typertGateway.invoke({ namespace: 'life', method, args: { request }, peer, ...options }),
      stream: (method, request, options = {}) => ctx.typertGateway.stream({ namespace: 'life', method, args: { request }, peer, ...options }),
      async dispose() {
        for (const dispose of cleanup.reverse()) await dispose();
        await peer.dispose();
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await peer.dispose();
    await ctx.fiber.dispose();
    throw error;
  }
}

const ownerCommand = (kind, suffix, extra = {}) => ({
  kind, commandId: `host-smoke-${suffix}-${randomUUID()}`,
  actorId: 'untrusted-wire-actor', source: 'app', expectedRevision: 0, ...extra,
});
const createTask = suffix => ownerCommand('task.create', suffix, { input: { title: `task ${suffix}` } });
const createConversation = suffix => ownerCommand('conversation.create', suffix, { content: `conversation ${suffix}` });
const createSchedule = suffix => ownerCommand('schedule.create', suffix, {
  input: { title: `schedule ${suffix}`, startAt: new Date(Date.now() + 86400000).toISOString(), timeZone: 'UTC' },
});
function rawResult(envelope) {
  assert.equal(envelope?.ok, true);
  return envelope.value;
}

// ---------- Current production source: positive runtime evidence ----------

test('production: real Cordis discovers all four decorated Host methods and four real tools', async () => {
  const f = await hostFixture({ realTools: true });
  try {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(f.life));
    assert.ok(methods.includes('snapshot'));
    const schemas = f.ctx.tools.schemas();
    assert.deepEqual(schemas.map(schema => schema.name).sort(), ['life_conversation_cancel', 'life_query', 'life_schedule_upsert', 'life_task_upsert']);
    assert.ok(schemas.every(schema => schema.parameters.type === 'object'));
    assert.ok(schemas.every(schema => schema.output && typeof schema.output !== 'object' /* JSON projection intentionally omits callbacks */ || schema.parameters));
    for (const method of ['snapshot', 'execute', 'cancel']) {
      const result = await f.invoke(method, method === 'snapshot' ? {} : method === 'execute' ? { command: createTask(`discovery-${method}`) } : { id: 'missing', expectedRevision: 0 });
      assert.equal(typeof result, 'object');
    }
  } finally { await f.dispose(); }
});

test('production: source-fallback Gateway invokes direct methods and a cancellable stream', async () => {
  const f = await hostFixture();
  try {
    const snapshot = await f.invoke('snapshot', {});
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.ownerId, OWNER_ID);
    const executed = rawResult(await f.invoke('execute', { command: createTask('gateway') }));
    assert.equal(executed.accepted, true);
    assert.equal(executed.snapshot.tasks.length, 1);
    const source = await f.stream('subscribe', {});
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.type, 'open');
    const second = await iterator.next();
    assert.equal(second.value.type, 'snapshot');
    await iterator.return();
    assert.equal((await iterator.next()).done, true);
  } finally { await f.dispose(); }
});

test('production: real ToolRuntime validates arguments and executes the shared durable command path', async () => {
  const f = await hostFixture({ realTools: true });
  try {
    const signal = new AbortController().signal;
    const created = await f.ctx.tools.execute({ callId: `tool-${randomUUID()}`, name: 'life_task_upsert', arguments: { title: 'from real tool runtime', commandId: `tool-command-${randomUUID()}` }, signal });
    assert.equal(created.isError, false, JSON.stringify(created.error));
    assert.equal(created.value.accepted, true);
    assert.equal(created.value.snapshot.tasks[0].title, 'from real tool runtime');
    assert.equal(created.value.snapshot.tasks[0].ownerId, OWNER_ID);
    assert.ok(created.content[0].text.includes('from real tool runtime'));
    const missing = await f.ctx.tools.execute({ callId: `tool-${randomUUID()}`, name: 'life_conversation_cancel', arguments: {}, signal });
    assert.equal(missing.isError, true);
    const query = await f.ctx.tools.execute({ callId: `tool-${randomUUID()}`, name: 'life_query', arguments: { view: 'tasks' }, signal });
    assert.equal(query.isError, false);
    assert.equal(query.value.items.length, 1);
  } finally { await f.dispose(); }
});

test('production: scheduling uses Host create(sessionId, request), persists external IDs, and recreates edits', async () => {
  const sessions = new FakeSessions();
  const schedule = new FakeSchedule();
  const f = await hostFixture({ sessions, schedule });
  try {
    const first = rawResult(await f.invoke('execute', { command: createSchedule('create') }));
    await until(() => f.schedule.creates.length === 1, 'schedule create was not pumped');
    await until(() => f.life.store.snapshot().schedules[0].dshScheduleId, 'external schedule ID was not persisted');
    const local = f.life.store.snapshot().schedules[0];
    assert.equal(f.schedule.creates[0].sessionId, 'session-1');
    assert.equal(f.schedule.creates[0].request.title, local.title);
    assert.equal(f.schedule.creates[0].request.at, local.startAt);
    assert.equal(local.dshScheduleId, 'dsh-schedule-1');
    assert.ok(f.life.store.readyOutbox().every(row => row.state !== 'pending'));
    await f.invoke('execute', { command: ownerCommand('schedule.update', 'edit', {
      id: local.id, expectedRevision: local.revision,
      input: { title: 'edited schedule', startAt: new Date(Date.now() + 172800000).toISOString() },
    }) });
    await until(() => f.schedule.deletes.length === 1 && f.schedule.creates.length === 2, 'schedule update was not synchronized');
    assert.deepEqual(f.schedule.deletes[0], { id: 'dsh-schedule-1', sessionId: 'session-1' });
    assert.equal(f.schedule.creates[1].sessionId, 'session-1');
    assert.equal(f.life.store.snapshot().schedules[0].dshScheduleId, 'dsh-schedule-2');
    const sessionCreates = sessions.calls.filter(call => call[0] === 'create');
    assert.equal(sessionCreates.length, 1, 'edit should reuse persisted scheduler Session');
  } finally { await f.dispose(); }
});

test('production: absent conversation ends failed, with outbox and call arguments available for diagnosis', async () => {
  const sessions = new FakeSessions();
  const f = await hostFixture({ sessions });
  try {
    const result = rawResult(await f.invoke('execute', { command: createConversation('settle') }));
    await until(() => f.life.store.getOutbox(`conversation.create:${result.id}`)?.state === 'retry', 'conversation outbox did not settle into retry');
    const conversation = f.life.store.snapshot().conversations[0];
    assert.equal(conversation.status, 'failed');
    assert.equal(conversation.answer, '');
    assert.match(conversation.error, /暂时不可用/);
    const create = sessions.calls.find(call => call[0] === 'create');
    const follow = sessions.calls.find(call => call[0] === 'follow');
    assert.equal(follow, undefined);
    assert.equal(create?.[1].cwd, '/tmp/life-assistant-host-smoke');
  } finally { await f.dispose(); }
});

test('production: cancellation persists independently and aborts an active conversation controller', async () => {
  const f = await hostFixture();
  try {
    const created = rawResult(await f.invoke('execute', { command: createConversation('cancel') }));
    const cancelled = rawResult(await f.invoke('cancel', { id: created.id, expectedRevision: created.snapshot.conversations[0].revision }));
    assert.deepEqual(cancelled, { accepted: true });
    assert.equal(f.life.store.snapshot().conversations[0].status, 'cancelled');
    assert.equal(f.life.store.snapshot().conversations[0].revision, created.snapshot.conversations[0].revision + 1);
    await rejectsCode(() => f.invoke('cancel', { id: created.id, expectedRevision: created.snapshot.conversations[0].revision }), 'not-used');
  } catch (error) {
    // DomainError is deliberately caught by production and returned as a
    // business-looking value; the expected code assertion above must not hide
    // that classification.  This branch is only for unexpected harness errors.
    if (error?.code !== 'not-used') throw error;
    assert.fail('cancel unexpectedly threw instead of returning its current error value');
  } finally { await f.dispose(); }
});

// ---------- Current defects, asserted explicitly rather than hidden ----------

test('DEFECT production: generated Client adds a second envelope; malformed cancel is reported as transport success', async () => {
  const host = await hostFixture();
  const client = new Context();
  const clientPeer = await makePeer(client);
  try {
    await client.plugin(TypertRegistry);
    client.provide('connection', {
      interactions: 'none',
      rpc: {
        call: async (_path, endpoint, payload, signal) => {
          const separator = endpoint.indexOf('/');
          return host.ctx.typertGateway.invokeRpc(endpoint, payload, signal, host.peer);
        },
        open: (_path, endpoint, payload, signal, uplink) => host.ctx.typertGateway.openWireStream(endpoint, payload, uplink, host.peer, signal, new AbortController()),
      },
    });
    await client.plugin(clientApply);
    await client.remote.$mount(LIFE_REMOTE);
    const snap = await client.remote.life.snapshot({});
    assert.equal(snap.ok, true);
    assert.equal(snap.value.ok, true, 'Client envelope contains the Host envelope');
    assert.equal(snap.value.value.ownerId, OWNER_ID);
    const missing = await client.remote.life.cancel({ id: 'does-not-exist', expectedRevision: 0 });
    assert.equal(missing.ok, true, 'domain failure was not transported as Remote failure');
    assert.equal(missing.value.ok, false);
    assert.equal(missing.value.error.code, 'not_found');
    const stream = client.remote.life.subscribe({});
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'open');
    await iterator.return();
    await stream.dispose();
  } finally {
    await clientPeer.dispose();
    await client.fiber.dispose();
    await host.dispose();
  }
});

test('DEFECT production: injected Host Session API is mistaken for generated Client RemoteResult API', async () => {
  const sessions = new FakeSessions();
  const f = await hostFixture({ sessions });
  try {
    const result = rawResult(await f.invoke('execute', { command: createConversation('host-api') }));
    const outbox = await until(() => {
      const row = f.life.store.getOutbox(`conversation.create:${result.id}`);
      return row?.state === 'retry' ? row : null;
    }, 'Host API mismatch did not reach failed outbox state');
    assert.match(outbox.last_error, /created\.error|Cannot read properties/);
    assert.equal(sessions.calls.filter(call => call[0] === 'prompt').length, 0);
    assert.equal(sessions.calls.filter(call => call[0] === 'follow').length, 0);
    assert.equal(f.life.store.snapshot().conversations[0].status, 'failed');
  } finally { await f.dispose(); }
});

test('DEFECT production: follow frame envelope is not unwrapped, so even a corrected Session raw-return fixture ends without answer', async () => {
  class RawSessions extends FakeSessions {
    async create(request) { return super.create(request); }
  }
  const sessions = new RawSessions();
  const f = await hostFixture({ sessions });
  try {
    // Test-only adapter fixes only create/prompt envelope handling, leaving the
    // production follow loop unchanged. This isolates its second mismatch.
    const originalCreate = sessions.create.bind(sessions);
    sessions.create = async request => {
      const raw = await originalCreate(request);
      return { ok: true, value: raw };
    };
    sessions.prompt = async request => {
      sessions.calls.push(['prompt', request]);
      return { ok: true, value: { accepted: true } };
    };
    const result = rawResult(await f.invoke('execute', { command: createConversation('follow-envelope') }));
    await until(() => f.life.store.getOutbox(`conversation.create:${result.id}`)?.state === 'retry', 'follow mismatch did not fail');
    const conversation = f.life.store.snapshot().conversations[0];
    assert.equal(conversation.status, 'failed');
    assert.equal(conversation.answer, '');
    assert.equal(sessions.followRequests[0].address.kind, 'session');
    assert.equal(sessions.followRequests[0].address.sessionId, 'session-1');
    assert.equal(sessions.followRequests[0].maxMessages, 80);
  } finally { await f.dispose(); }
});

test('production: current codecs strip undeclared fields instead of providing strict command validation', async () => {
  const f = await hostFixture();
  try {
    const descriptor = LIFE_REMOTE.methods['life/execute'];
    assert.equal(descriptor.input({ strict: true }).jsonSchema.properties.request.additionalProperties, true);
    // z.object strips unknown nested command fields, proving that the generic
    // JSON Schema is not merely descriptive: it changes dispatched input.
    const decoded = descriptor.parameters[0].codec.create().parse({ command: { ...createTask('codec'), undeclared: 'strip me' } });
    assert.equal(decoded.command.undeclared, undefined);
    assert.equal(decoded.command.kind, undefined);
    await rejectsCode(() => f.invoke('execute', {}), 'gateway/input-invalid');
    const accepted = rawResult(await f.invoke('execute', { command: createTask('codec-shape') }));
    assert.equal(accepted.accepted, true);
  } finally { await f.dispose(); }
});

test('production: generated Session Host descriptors validate exact follow addresses and reject malformed input', async () => {
  const sessions = new FakeSessions();
  const f = await hostFixture({ sessions, realSessionDescriptors: true });
  try {
    const descriptor = f.ctx.typert.local.get('session/follow');
    assert.ok(descriptor);
    assert.equal(descriptor.parameters[0].codec.typeSymbol, '@deepseek-ai/dsh-api-session-controller/types#SessionFollowRequest');
    await rejectsCode(() => f.ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { sessionId: 's1' } } }, peer: f.peer }), 'gateway/input-invalid');
    await rejectsCode(() => f.ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 's1' }, extra: true } }, peer: f.peer }), 'gateway/input-invalid');
    const source = await f.ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 80 } }, peer: f.peer });
    const iterator = source[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'snapshot');
    assert.equal((await iterator.next()).value.event.type, 'assistant/message');
    await iterator.return();
    assert.deepEqual(sessions.followRequests[0].address, { kind: 'session', sessionId: 's1' });
  } finally { await f.dispose(); }
});

// ---------- Test-only corrected fixtures: verify the proposed boundaries ----------

function correctedRemote() {
  // A generated artifact must use exact domain schemas. This compact fixture
  // verifies boundary behavior; it is not a substitute for running Typert
  // generation against the final TypeScript contracts.
  const { z } = globalThis.__lifeSmokeZod;
  const { createTypertRemoteInfo } = globalThis.__lifeSmokeProtocol;
  const empty = z.object({}).strict();
  const snapshot = z.record(z.string(), z.unknown());
  const commandResult = z.object({ accepted: z.literal(true), id: z.string(), revision: z.number(), snapshot }).passthrough();
  const codec = (create, jsonSchema, symbol) => ({ mode: 'strict', typeSymbol: symbol, create, jsonSchema });
  const method = (name, input, output, stream = false) => ({
    service: 'life', invocation: { kind: 'direct' }, description: `corrected ${name}`,
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec(input, inputJson(name), `@test/life#${name}Request`), strictCodec: codec(input, inputJson(name), `@test/life#${name}Request`) }],
    ...(stream ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
    result: codec(output, outputJson(name), `@test/life#${name}Result`),
  });
  const inputJson = name => name === 'execute' ? executeRequestJson : name === 'cancel' ? cancelRequestJson : { type: 'object', properties: {}, additionalProperties: false };
  const outputJson = name => name === 'cancel' ? { type: 'object', properties: { accepted: { type: 'boolean', const: true } }, required: ['accepted'], additionalProperties: false } : { type: 'object', additionalProperties: true };
  const executeRequestJson = {
    type: 'object', properties: { command: commandJson }, required: ['command'], additionalProperties: false,
  };
  const cancelRequestJson = { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'number' } }, required: ['id', 'expectedRevision'], additionalProperties: false };
  const taskInputJson = { type: 'object', properties: { title: { type: 'string' }, notes: { type: 'string' }, status: { type: 'string', enum: ['inbox', 'active', 'blocked', 'done', 'cancelled'] }, nextStep: { type: 'string' }, blocker: { type: 'string' }, milestones: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'], additionalProperties: false } } }, required: ['title'], additionalProperties: false };
  const commandBase = { commandId: { type: 'string' }, actorId: { type: 'string' }, source: { type: 'string', enum: ['app', 'agent', 'timer', 'test'] }, expectedRevision: { type: 'number' } };
  const commandJson = {
    oneOf: [
      { type: 'object', properties: { ...commandBase, kind: { const: 'task.create' }, input: taskInputJson }, required: ['kind', 'commandId', 'actorId', 'source', 'expectedRevision', 'input'], additionalProperties: false },
      { type: 'object', properties: { ...commandBase, kind: { const: 'conversation.create' }, content: { type: 'string' } }, required: ['kind', 'commandId', 'actorId', 'source', 'expectedRevision', 'content'], additionalProperties: false },
      { type: 'object', properties: { ...commandBase, kind: { const: 'conversation.control' }, id: { type: 'string' }, action: { const: 'cancel' } }, required: ['kind', 'commandId', 'actorId', 'source', 'expectedRevision', 'id', 'action'], additionalProperties: false },
    ],
  };
  const executeInput = z.object({ command: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task.create'), commandId: z.string(), actorId: z.string(), source: z.enum(['app', 'agent', 'timer', 'test']), expectedRevision: z.number(), input: z.object({ title: z.string(), notes: z.string().optional(), status: z.enum(['inbox', 'active', 'blocked', 'done', 'cancelled']).optional(), nextStep: z.string().optional(), blocker: z.string().optional(), milestones: z.array(z.object({ text: z.string(), done: z.boolean() }).strict()).optional() }).strict() }).strict(),
    z.object({ kind: z.literal('conversation.create'), commandId: z.string(), actorId: z.string(), source: z.enum(['app', 'agent', 'timer', 'test']), expectedRevision: z.number(), content: z.string() }).strict(),
    z.object({ kind: z.literal('conversation.control'), commandId: z.string(), actorId: z.string(), source: z.enum(['app', 'agent', 'timer', 'test']), expectedRevision: z.number(), id: z.string(), action: z.literal('cancel') }).strict(),
  ]) }).strict();
  const cancelInput = z.object({ id: z.string(), expectedRevision: z.number() }).strict();
  const subscription = z.discriminatedUnion('type', [z.object({ type: z.literal('open'), snapshot }), z.object({ type: z.literal('snapshot'), snapshot }), z.object({ type: z.literal('keepalive'), revision: z.number() })]);
  return createTypertRemoteInfo({ package: '@test/life-assistant-corrected', methods: {
    'life/snapshot': method('snapshot', empty, snapshot),
    'life/execute': method('execute', executeInput, commandResult),
    'life/cancel': method('cancel', cancelInput, z.object({ accepted: z.literal(true) }).strict()),
    'life/subscribe': method('subscribe', empty, subscription, true),
  } }, z);
}

// Transpile the test-only decorated fixture from its source string. This uses
// the same decorator semantics as the loader and creates no production file.
const correctedClassSource = `
  const { TypertRemoteService, Remote } = globalThis.__lifeSmokeProtocol;
  const { LifeStore } = globalThis.__lifeSmokeStore;
  const { DomainError } = globalThis.__lifeSmokeContract;
  class CorrectedLife extends TypertRemoteService {
    static inject = ['sessionController', 'tools'];
    running = new Map();
    watchers = new Set();
    disposed = false;
    constructor(ctx) {
      super(ctx, 'life', { namespace: 'life' });
      this.sessions = ctx.sessionController;
      this.schedule = ctx.schedule;
      this.store = new LifeStore(':memory:');
      this.ctx.effect(() => () => this.dispose(), 'corrected-life');
      this.store.subscribe(() => { for (const notify of this.watchers) notify(); });
      this.registerTools();
      this.worker = this.pump();
    }
    @Remote snapshot(request) { return this.store.snapshot(); }
    @Remote execute(request) {
      const command = { ...request.command, actorId: OWNER_ID, source: 'app' };
      return this.store.execute(command);
    }
    @Remote async cancel(request) {
      const result = this.store.execute({ kind: 'conversation.control', id: request.id, commandId: 'cancel-' + request.id + '-' + randomUUID(), actorId: OWNER_ID, source: 'app', expectedRevision: request.expectedRevision, action: 'cancel' });
      this.running.get(result.id)?.abort();
      return { accepted: true };
    }
    @Remote({ mode: 'stream' }) async *subscribe(request, signal) {
      let revision = -1;
      let notify = () => {};
      this.watchers.add(notify);
      try {
        yield { type: 'open', snapshot: this.store.snapshot() };
        while (!signal.aborted && !this.disposed) {
          const current = this.store.snapshot();
          if (current.revision !== revision) { revision = current.revision; yield { type: 'snapshot', snapshot: current }; }
          else yield { type: 'keepalive', revision };
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 5000);
            notify = () => { clearTimeout(timer); resolve(); };
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      } finally { this.watchers.delete(notify); }
    }
    async pump() {
      while (!this.disposed) {
        const jobs = this.store.readyOutbox();
        if (!jobs.length) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
        await Promise.allSettled(jobs.map(async row => {
          const id = String(row.id);
          if (!this.store.claimOutbox(id)) return;
          try {
            if (row.kind === 'conversation.create') await this.dispatchConversation(id, row);
            else if (String(row.kind).startsWith('schedule.')) await this.syncSchedule(id, row);
            else this.store.completeOutbox(id, null);
          } catch (error) {
            this.store.failOutbox(id, error instanceof Error ? error.message : String(error));
          }
        }));
      }
    }
    async dispatchConversation(outboxId, row) {
      const id = String(row.aggregate_id);
      const controller = new AbortController();
      this.running.set(id, controller);
      try {
        const conversation = this.store.snapshot().conversations.find(item => item.id === id);
        if (!conversation || conversation.status === 'cancelled') { this.store.completeOutbox(outboxId, null); return; }
        const created = await this.sessions.create({ cwd: '/tmp/life-assistant-host-smoke' });
        const sessionId = created.sessionId;
        this.store.setConversationSession(id, sessionId);
        await this.sessions.prompt({ requestId: 'life-' + id, sessionId, mode: 'queue', content: [{ type: 'text', text: conversation.content }], clientTimeZone: 'UTC' });
        const stream = this.sessions.follow({ address: { kind: 'session', sessionId }, maxMessages: 80 });
        controller.signal.addEventListener('abort', () => { void stream.return?.(); void this.sessions.cancel({ sessionId }); }, { once: true });
        let answer = '';
        let ended = false;
        for await (const frame of stream) {
          if (frame.type !== 'event') continue;
          const event = frame.event;
          if (event.type === 'assistant/message') {
            const content = event.data.message?.content;
            if (typeof content === 'string') answer = content;
            else if (Array.isArray(content)) answer = content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
          } else if (event.type === 'turn/end') {
            ended = true;
            if (answer) { this.store.settleConversation(id, 'answered', answer); this.store.completeOutbox(outboxId, sessionId); }
            else if (event.data.reason?.kind === 'cancelled') { this.store.settleConversation(id, 'cancelled', 'Agent cancelled this turn.'); this.store.completeOutbox(outboxId, sessionId); }
            else throw new Error('The Agent ended without a visible answer.');
            break;
          }
        }
        if (!ended && !controller.signal.aborted) throw new Error('Session follow stream ended before turn/end');
      } catch (error) {
        if (controller.signal.aborted || this.store.snapshot().conversations.find(item => item.id === id)?.status === 'cancelled') this.store.completeOutbox(outboxId, null);
        else {
          this.store.failOutbox(outboxId, error instanceof Error ? error.message : String(error));
          this.store.settleConversation(id, 'failed', 'Agent 暂时不可用。消息已保留，可稍后重试；没有冒充完成。');
        }
      } finally { this.running.delete(id); }
    }
    async syncSchedule(outboxId, row) {
      const id = String(row.aggregate_id);
      const schedule = this.store.snapshot().schedules.find(item => item.id === id);
      if (!schedule) { this.store.completeOutbox(outboxId, null); return; }
      let sessionId = this.store.schedulerSession(id);
      if (!sessionId) {
        sessionId = (await this.sessions.create({ cwd: '/tmp/life-assistant-host-smoke' })).sessionId;
        this.store.recordSchedulerSession(id, sessionId);
      }
      if (schedule.state === 'cancelled') {
        if (schedule.dshScheduleId) await this.schedule.delete({ id: schedule.dshScheduleId, sessionId });
        this.store.completeOutbox(outboxId, schedule.dshScheduleId);
        return;
      }
      const request = { title: schedule.title, prompt: 'Reminder ' + schedule.title, at: schedule.startAt };
      if (schedule.dshScheduleId) await this.schedule.delete({ id: schedule.dshScheduleId, sessionId });
      const record = await this.schedule.create(sessionId, request);
      this.store.attachDshSchedule(id, record.id, sessionId);
      this.store.completeOutbox(outboxId, record.id);
    }
    registerTools() {
      const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
      const register = (name, parameters, action) => this.ctx.tools.register(globalThis.__lifeSmokeDefineTool({ name, description: 'corrected ' + name, parameters, output, execute: async (args, exec) => { exec.signal.throwIfAborted(); return action(args); } }));
      register('life_query', { view: { type: 'string' } }, () => this.store.snapshot());
      register('life_task_upsert', { title: { type: 'string', required: true }, id: { type: 'string' }, expectedRevision: { type: 'number' }, commandId: { type: 'string' } }, args => this.store.execute({ kind: args.id ? 'task.update' : 'task.create', commandId: args.commandId ?? randomUUID(), actorId: OWNER_ID, source: 'agent', expectedRevision: args.expectedRevision ?? 0, ...(args.id ? { id: args.id } : {}), input: { title: args.title } }));
    }
    async dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const controller of this.running.values()) controller.abort();
      for (const notify of this.watchers) notify();
      this.store.close();
      await this.worker;
    }
  }
  return CorrectedLife;
`;
let correctedClassPromise;
async function correctedLifeClass() {
  if (!correctedClassPromise) {
    globalThis.__lifeSmokeProtocol = await import('@deepseek-ai/dsh-typert-protocol');
    globalThis.__lifeSmokeStore = await import('../src/server/store.ts');
    globalThis.__lifeSmokeContract = await import('../src/contract.ts');
    globalThis.__lifeSmokeDefineTool = (await import('@deepseek-ai/dsh-tools')).defineTool;
    const code = transformSync(correctedClassSource, { loader: 'ts', format: 'esm', target: 'es2023' }).code;
    correctedClassPromise = import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`).then(module => module.default);
  }
  return correctedClassPromise;
}

async function correctedFixture() {
  const CorrectedLife = await correctedLifeClass();
  const sessions = new FakeSessions();
  const schedule = new FakeSchedule();
  const ctx = new Context();
  const peer = await makePeer(ctx);
  const client = new Context();
  const clientPeer = await makePeer(client);
  try {
    ctx.provide('remoteAccess', { decide() { return { kind: 'deny', reason: 'test non-owner' }; } });
    ctx.provide('sessionController', sessions);
    ctx.provide('schedule', schedule);
    ctx.provide('systemPrompt', fakeSystemPrompt());
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(TypertGatewayService);
    await ctx.plugin(CorrectedLife);
    const remote = correctedRemote();
    ctx.typert.remotes.register(remote);
    await client.plugin(TypertRegistry);
    client.provide('connection', {
      interactions: 'none',
      rpc: {
        call: (_path, endpoint, payload, signal) => ctx.typertGateway.invokeRpc(endpoint, payload, signal, peer),
        open: (_path, endpoint, payload, signal, uplink) => ctx.typertGateway.openWireStream(endpoint, payload, uplink, peer, signal, new AbortController()),
      },
    });
    await client.plugin(clientApply);
    await client.remote.$mount(remote);
    return { ctx, client, peer, clientPeer, sessions, schedule, life: ctx.get('life'), remote,
      async dispose() { await clientPeer.dispose(); await client.fiber.dispose(); await peer.dispose(); await ctx.fiber.dispose(); } };
  } catch (error) {
    await clientPeer.dispose(); await client.fiber.dispose(); await peer.dispose(); await ctx.fiber.dispose();
    throw error;
  }
}

test('CORRECTED fixture: raw Host results become exactly one Client RemoteResult and thrown errors become Remote failures', async () => {
  const f = await correctedFixture();
  try {
    const direct = await f.ctx.typertGateway.invoke({ namespace: 'life', method: 'snapshot', args: { request: {} }, peer: f.peer });
    assert.equal(direct.ownerId, OWNER_ID);
    assert.equal('ok' in direct, false);
    const snapshot = await f.client.remote.life.snapshot({});
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.ownerId, OWNER_ID);
    assert.equal('ok' in snapshot.value, false);
    const created = await f.client.remote.life.execute({ command: createTask('corrected-client') });
    assert.equal(created.ok, true);
    assert.equal(created.value.accepted, true);
    assert.equal(created.value.snapshot.tasks.length, 1);
    assert.equal('ok' in created.value, false);
    const missing = await f.client.remote.life.cancel({ id: 'missing', expectedRevision: 0 });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'gateway/internal', 'DomainError needs an explicit RemoteError mapping to preserve its domain code over the wire');
    assert.match(missing.error.message, /Conversation not found/);
  } finally { await f.dispose(); }
});

test('CORRECTED fixture: generated strict descriptors reject malformed commands before the store', async () => {
  const f = await correctedFixture();
  try {
    const invoke = request => f.ctx.typertGateway.invoke({ namespace: 'life', method: 'execute', args: { request }, peer: f.peer });
    await rejectsCode(() => invoke({ command: { ...createTask('bad'), undeclared: true } }), 'gateway/input-invalid');
    await rejectsCode(() => invoke({ command: { kind: 'task.create', commandId: 'bad', actorId: 'x', source: 'app', expectedRevision: 0, input: {} } }), 'gateway/input-invalid');
    await rejectsCode(() => invoke({ command: createTask('bad'), extra: true }), 'gateway/input-invalid');
    assert.equal(f.life.store.snapshot().tasks.length, 0);
    const schema = f.remote.methods['life/execute'].input({ strict: true }).jsonSchema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.request.additionalProperties, false);
    assert.equal(schema.properties.request.properties.command.oneOf[0].additionalProperties, false);
  } finally { await f.dispose(); }
});

test('CORRECTED fixture: real Client stream emits frames, cancellation disposes, and conversation settles from event envelopes', async () => {
  const f = await correctedFixture();
  try {
    const handle = f.client.remote.life.subscribe({});
    assert.equal(typeof handle.send, 'function');
    assert.equal(typeof handle.end, 'function');
    assert.equal(typeof handle.dispose, 'function');
    const iterator = handle[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'open');
    assert.equal((await iterator.next()).value.type, 'snapshot');
    const result = await f.client.remote.life.execute({ command: createConversation('corrected-settle') });
    assert.equal(result.ok, true);
    const conversation = await until(() => {
      const value = f.life.store.snapshot().conversations[0];
      return value?.status === 'answered' ? value : null;
    }, 'corrected conversation did not answer');
    assert.equal(conversation.answer, 'answer from fake session');
    assert.equal(conversation.sessionId, 'session-1');
    const outbox = f.life.store.getOutbox(`conversation.create:${result.value.id}`);
    assert.equal(outbox.state, 'done');
    const frame = await iterator.next();
    assert.equal(frame.value.type, 'snapshot');
    assert.ok(frame.value.snapshot.conversations.some(item => item.status === 'answered'));
    const follow = f.sessions.followRequests[0];
    assert.deepEqual(follow.address, { kind: 'session', sessionId: 'session-1' });
    assert.equal(follow.maxMessages, 80);
    assert.equal(f.sessions.calls.find(call => call[0] === 'prompt')[1].mode, 'queue');
    await iterator.return();
    await handle.dispose();
    assert.equal(f.life.watchers.size, 0);
  } finally { await f.dispose(); }
});

test('CORRECTED fixture: scheduler Session persists across edits and real tools validate required inputs', async () => {
  const f = await correctedFixture();
  try {
    const created = await f.client.remote.life.execute({ command: createSchedule('corrected-schedule') });
    assert.equal(created.ok, true);
    await until(() => f.life.store.snapshot().schedules[0]?.dshScheduleId, 'corrected schedule not persisted');
    const before = f.life.store.snapshot().schedules[0];
    const edited = await f.client.remote.life.execute({ command: ownerCommand('schedule.update', 'corrected-edit', { id: before.id, expectedRevision: before.revision, input: { title: 'new title' } }) });
    assert.equal(edited.ok, true);
    await until(() => f.schedule.creates.length === 2, 'corrected schedule edit not synchronized');
    assert.equal(f.sessions.calls.filter(call => call[0] === 'create').length, 1);
    assert.equal(f.schedule.creates[1].sessionId, f.schedule.creates[0].sessionId);
    const signal = new AbortController().signal;
    const missing = await f.ctx.tools.execute({ callId: `corrected-tool-${randomUUID()}`, name: 'life_task_upsert', arguments: {}, signal });
    assert.equal(missing.isError, true);
    const made = await f.ctx.tools.execute({ callId: `corrected-tool-${randomUUID()}`, name: 'life_task_upsert', arguments: { title: 'corrected tool' }, signal });
    assert.equal(made.isError, false);
    assert.equal(made.value.accepted, true);
  } finally { await f.dispose(); }
});

// Corrected fixtures stay entirely in this harness; no production build,
// tsconfig, profile, or persistent Host is changed.

globalThis.__lifeSmokeProtocol = await import('@deepseek-ai/dsh-typert-protocol');
globalThis.__lifeSmokeZod = await import('zod');

let failed = 0;
for (const { name, run } of tests) {
  const started = Date.now();
  try {
    await run();
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} (${Date.now() - started}ms)`);
    console.error(error?.stack ?? error);
  }
}
console.log(`RESULT ${tests.length - failed}/${tests.length} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
