import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command, CommandResult, Event, Snapshot, Task, Schedule, Conversation, Source } from '../contract.ts';
import { DomainError, OWNER_ID } from '../contract.ts';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta VALUES ('revision','0');
CREATE TABLE IF NOT EXISTS commands (
  owner_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_id,command_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL,
  status TEXT NOT NULL, next_step TEXT NOT NULL, blocker TEXT NOT NULL, milestones TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, start_at TEXT NOT NULL,
  end_at TEXT, time_zone TEXT NOT NULL, notes TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL,
  dsh_schedule_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT, content TEXT NOT NULL,
  status TEXT NOT NULL, answer TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL, actor_id TEXT NOT NULL, source TEXT NOT NULL,
  command_id TEXT, at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL, kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, external_id TEXT, last_error TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(kind,aggregate_id,created_at)
);
CREATE TABLE IF NOT EXISTS delivery (
  aggregate_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(aggregate_id,kind)
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  source TEXT NOT NULL, command_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, applied_revision INTEGER NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_aggregate ON events(aggregate_id,seq);
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(state,next_attempt_at);
`;

function json<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function object(value: unknown, name = 'input'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('invalid', `${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError('invalid', `${name} must contain 1–${max} characters`);
  return value.trim();
}
function date(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new DomainError('invalid', `${name} must be an ISO date/time`);
  return new Date(value).toISOString();
}
function zone(value: unknown): string {
  const result = text(value, 'timeZone', 100);
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: result }); } catch { throw new DomainError('invalid', 'Unknown IANA time zone'); }
  return result;
}
function status(value: unknown): Task['status'] {
  if (!['inbox','active','blocked','done','cancelled'].includes(String(value))) throw new DomainError('invalid', 'Invalid task status');
  return value as Task['status'];
}
function taskFrom(row: Record<string, unknown>): Task {
  return { id: String(row.id), title: String(row.title), notes: String(row.notes), status: row.status as Task['status'], ownerId: String(row.owner_id), nextStep: String(row.next_step), blocker: String(row.blocker), milestones: json(String(row.milestones), []), createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: row.completed_at == null ? null : String(row.completed_at), revision: Number(row.revision) };
}
function scheduleFrom(row: Record<string, unknown>): Schedule {
  return { id: String(row.id), title: String(row.title), startAt: String(row.start_at), endAt: row.end_at == null ? null : String(row.end_at), timeZone: String(row.time_zone), notes: String(row.notes), taskId: row.task_id == null ? null : String(row.task_id), state: row.state as Schedule['state'], dshScheduleId: row.dsh_schedule_id == null ? null : String(row.dsh_schedule_id), ownerId: String(row.owner_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at), revision: Number(row.revision) };
}
function conversationFrom(row: Record<string, unknown>): Conversation {
  return { id: String(row.id), sessionId: row.session_id == null ? null : String(row.session_id), content: String(row.content), status: row.status as Conversation['status'], answer: String(row.answer), error: row.error == null ? null : String(row.error), ownerId: String(row.owner_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at), revision: Number(row.revision) };
}
function eventFrom(row: Record<string, unknown>): Event {
  return { seq: Number(row.seq), id: String(row.id), kind: String(row.kind), aggregateId: String(row.aggregate_id), actorId: String(row.actor_id), source: row.source as Source, commandId: row.command_id == null ? null : String(row.command_id), at: String(row.at), payload: json(String(row.payload), {}) };
}

export class LifeStore {
  readonly db: DatabaseSync;
  private listeners = new Set<() => void>();
  readonly path: string;
  private readonly now: () => Date;
  constructor(path: string, now: () => Date = () => new Date()) {
    this.path = path; this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    try { this.db.exec("ALTER TABLE outbox ADD COLUMN lease_until TEXT"); } catch (error) { if (!(error instanceof Error) || !error.message.includes('duplicate column')) throw error; }
  }
  close() { this.db.close(); this.listeners.clear(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const listener of this.listeners) listener(); }
  private time() { return this.now().toISOString(); }
  private revision() { return Number((this.db.prepare("SELECT value FROM meta WHERE key='revision'").get() as { value: string }).value); }
  private tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private event(kind: string, aggregateId: string, actorId: string, source: Source, commandId: string | null, payload: Record<string, unknown>, ownerId = OWNER_ID, outbox = false) {
    const at = this.time(); const id = randomUUID();
    const result = this.db.prepare('INSERT INTO events(id,kind,aggregate_id,actor_id,source,command_id,at,payload) VALUES(?,?,?,?,?,?,?,?)').run(id,kind,aggregateId,actorId,source,commandId,at,JSON.stringify(payload));
    if (outbox) this.db.prepare('INSERT OR IGNORE INTO outbox(id,event_seq,kind,aggregate_id,owner_id,payload,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),Number(result.lastInsertRowid),kind,aggregateId,ownerId,JSON.stringify(payload),'pending',at,at,at);
  }
  snapshot(ownerId = OWNER_ID): Snapshot {
    if (ownerId !== OWNER_ID) throw new DomainError('forbidden', 'Unknown owner');
    const tasks = (this.db.prepare('SELECT * FROM tasks WHERE owner_id=? ORDER BY updated_at DESC').all(ownerId) as unknown as Record<string,unknown>[]).map(taskFrom);
    const schedules = (this.db.prepare('SELECT * FROM schedules WHERE owner_id=? ORDER BY start_at').all(ownerId) as unknown as Record<string,unknown>[]).map(scheduleFrom);
    const conversations = (this.db.prepare('SELECT * FROM conversations WHERE owner_id=? ORDER BY created_at DESC LIMIT 80').all(ownerId) as unknown as Record<string,unknown>[]).map(conversationFrom);
    const events = (this.db.prepare('SELECT * FROM events WHERE actor_id=? OR aggregate_id IN (SELECT id FROM tasks WHERE owner_id=?) OR aggregate_id IN (SELECT id FROM schedules WHERE owner_id=?) OR aggregate_id IN (SELECT id FROM conversations WHERE owner_id=?) ORDER BY seq DESC LIMIT 120').all(ownerId,ownerId,ownerId,ownerId) as unknown as Record<string,unknown>[]).map(eventFrom).reverse();
    return { revision: this.revision(), ownerId, serverTime: this.time(), tasks, schedules, conversations, events, reminders: [], counts: { active: tasks.filter(t => t.status === 'active' || t.status === 'blocked').length, done: tasks.filter(t => t.status === 'done').length, upcoming: schedules.filter(s => s.state === 'active' && Date.parse(s.startAt) >= this.now().getTime()).length, pending: conversations.filter(c => c.status === 'accepted' || c.status === 'running').length }, capabilities: { agent: true, delivery: 'in-app', background: true, steer: 'step-boundary' } };
  }
  execute(input: Command): CommandResult {
    const command = object(input) as unknown as Command;
    const commandId = text(command.commandId,'commandId',120); const actorId = text(command.actorId,'actorId',120);
    if (command.actorId !== OWNER_ID && command.source !== 'agent') throw new DomainError('forbidden','Only the personal owner may issue this command');
    if (!['app','agent','timer','test'].includes(command.source)) throw new DomainError('invalid','Invalid source');
    const ownerId = OWNER_ID; const fingerprint = JSON.stringify(command);
    const cached = this.db.prepare('SELECT fingerprint,result FROM commands WHERE owner_id=? AND command_id=?').get(ownerId,commandId) as { fingerprint: string; result: string } | undefined;
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw new DomainError('conflict','commandId was already used for a different command');
      return json(cached.result, null as unknown as CommandResult);
    }
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) throw new DomainError('invalid','expectedRevision must be a non-negative integer');
    const result = this.tx(() => {
      const cached = this.db.prepare('SELECT fingerprint,result FROM commands WHERE owner_id=? AND command_id=?').get(ownerId,commandId) as { fingerprint: string; result: string } | undefined;
      if (cached) {
        if (cached.fingerprint !== fingerprint) throw new DomainError('conflict','commandId was already used for a different command');
        return json(cached.result, null as unknown as CommandResult);
      }
      const id = 'id' in command ? command.id : randomUUID();
      const at = this.time(); let aggregateRevision = 1;
      if (command.kind === 'task.create') {
        const p = object(command.input); const title = text(p.title,'title',200); const taskStatus = p.status == null ? 'active' : status(p.status);
        const notes = p.notes == null ? '' : text(p.notes,'notes',4000); const nextStep = p.nextStep == null ? '' : text(p.nextStep,'nextStep',500); const blocker = p.blocker == null ? '' : text(p.blocker,'blocker',500);
        const milestones = Array.isArray(p.milestones) ? p.milestones.map(m => ({ text: text(object(m,'milestone').text,'milestone',300), done: object(m).done === true })) : [];
        this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ownerId,title,notes,taskStatus,nextStep,blocker,JSON.stringify(milestones),at,at,taskStatus === 'done' ? at : null,1);
      } else if (command.kind === 'task.update') {
        const row = this.db.prepare('SELECT * FROM tasks WHERE id=? AND owner_id=?').get(command.id,ownerId) as Record<string,unknown> | undefined;
        if (!row) throw new DomainError('not_found','Task not found');
        const current = taskFrom(row); if (command.expectedRevision !== current.revision) throw new DomainError('conflict',`Task changed: expected revision ${command.expectedRevision}, current ${current.revision}`);
        const p = object(command.input); const next = { ...current };
        if (p.title !== undefined) next.title = text(p.title,'title',200);
        if (p.notes !== undefined) next.notes = text(p.notes,'notes',4000);
        if (p.status !== undefined) next.status = status(p.status);
        if (p.nextStep !== undefined) next.nextStep = text(p.nextStep,'nextStep',500);
        if (p.blocker !== undefined) next.blocker = text(p.blocker,'blocker',500);
        if (p.milestones !== undefined) { if (!Array.isArray(p.milestones)) throw new DomainError('invalid','milestones must be an array'); next.milestones = p.milestones.map(m => ({ text: text(object(m,'milestone').text,'milestone',300), done: object(m).done === true })); }
        aggregateRevision = current.revision + 1; next.updatedAt = at; next.completedAt = next.status === 'done' ? current.completedAt ?? at : null;
        this.db.prepare('UPDATE tasks SET title=?,notes=?,status=?,next_step=?,blocker=?,milestones=?,updated_at=?,completed_at=?,revision=? WHERE id=? AND owner_id=?').run(next.title,next.notes,next.status,next.nextStep,next.blocker,JSON.stringify(next.milestones),at,next.completedAt,aggregateRevision,id,ownerId);
      } else if (command.kind === 'schedule.create') {
        const p = object(command.input); const title = text(p.title,'title',200); const startAt = date(p.startAt,'startAt'); const endAt = p.endAt == null ? null : date(p.endAt,'endAt'); if (endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new DomainError('invalid','endAt must be after startAt');
        const timeZone = zone(p.timeZone); const notes = p.notes == null ? '' : text(p.notes,'notes',4000); const taskId = p.taskId == null ? null : text(p.taskId,'taskId',120);
        if (taskId && !this.db.prepare('SELECT id FROM tasks WHERE id=? AND owner_id=?').get(taskId,ownerId)) throw new DomainError('not_found','Linked task not found');
        this.db.prepare('INSERT INTO schedules(id,owner_id,title,start_at,end_at,time_zone,notes,task_id,state,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ownerId,title,startAt,endAt,timeZone,notes,taskId,'active',at,at,1);
      } else if (command.kind === 'schedule.update') {
        const row = this.db.prepare('SELECT * FROM schedules WHERE id=? AND owner_id=?').get(command.id,ownerId) as Record<string,unknown> | undefined;
        if (!row) throw new DomainError('not_found','Schedule not found'); const current = scheduleFrom(row);
        if (command.expectedRevision !== current.revision) throw new DomainError('conflict',`Schedule changed: expected revision ${command.expectedRevision}, current ${current.revision}`);
        const p = object(command.input); const next = { ...current };
        if (p.title !== undefined) next.title = text(p.title,'title',200);
        if (p.startAt !== undefined) next.startAt = date(p.startAt,'startAt');
        if (p.endAt !== undefined) next.endAt = p.endAt === null ? null : date(p.endAt,'endAt');
        if (p.timeZone !== undefined) next.timeZone = zone(p.timeZone);
        if (p.notes !== undefined) next.notes = text(p.notes,'notes',4000);
        if (p.state !== undefined) { const nextState = p.state; if (nextState !== 'active' && nextState !== 'cancelled') throw new DomainError('invalid','Invalid schedule state'); next.state = nextState; }
        if (next.endAt && Date.parse(next.endAt) <= Date.parse(next.startAt)) throw new DomainError('invalid','endAt must be after startAt');
        aggregateRevision = current.revision + 1;
        this.db.prepare('UPDATE schedules SET title=?,start_at=?,end_at=?,time_zone=?,notes=?,state=?,updated_at=?,revision=? WHERE id=? AND owner_id=?').run(next.title,next.startAt,next.endAt,next.timeZone,next.notes,next.state,at,aggregateRevision,id,ownerId);
      } else if (command.kind === 'conversation.create') {
        const content = text(command.content,'content',12000);
        this.db.prepare('INSERT INTO conversations(id,owner_id,content,status,answer,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?)').run(id,ownerId,content,'accepted','',at,at,1);
      } else if (command.kind === 'conversation.control') {
        const row = this.db.prepare('SELECT * FROM conversations WHERE id=? AND owner_id=?').get(id,ownerId) as Record<string,unknown> | undefined;
        if (!row) throw new DomainError('not_found','Conversation not found'); const current = conversationFrom(row);
        if (command.expectedRevision !== current.revision) throw new DomainError('conflict','Conversation changed; refresh before cancelling');
        if (!['accepted','running'].includes(current.status)) throw new DomainError('conflict','Only pending conversations can be cancelled');
        aggregateRevision = current.revision + 1;
        this.db.prepare("UPDATE conversations SET status='cancelled',error='Cancelled by user',updated_at=?,revision=? WHERE id=?").run(at,aggregateRevision,id);
      } else throw new DomainError('invalid','Unknown command kind');
      this.db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
      this.event(command.kind,id,actorId,command.source,commandId,{ input: command },ownerId,command.kind === 'conversation.create' || command.kind === 'schedule.create' || command.kind === 'schedule.update');
      this.db.prepare('INSERT INTO audit(owner_id,actor_id,source,command_id,kind,target_id,expected_revision,applied_revision,at) VALUES(?,?,?,?,?,?,?,?,?)').run(ownerId,actorId,command.source,commandId,command.kind,id,command.expectedRevision,aggregateRevision,at);
      const result = { accepted: true as const, id, revision: this.revision(), snapshot: this.snapshot(ownerId) };
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(ownerId,commandId,fingerprint,JSON.stringify(result),this.time());
      return result;
    });
    this.changed(); return result;
  }
  readyOutbox(limit = 8) { return this.db.prepare("SELECT * FROM outbox WHERE state IN ('pending','retry') AND next_attempt_at<=? ORDER BY event_seq LIMIT ?").all(this.time(),limit) as unknown as Record<string,unknown>[]; }
  claimOutbox(id: string) { return this.tx(() => { const at = this.time(); const leaseUntil = new Date(Date.parse(at)+30000).toISOString(); const result = this.db.prepare("UPDATE outbox SET state='processing',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=? AND (state IN ('pending','retry') OR state='processing' AND lease_until<=?)").run(leaseUntil,at,id,at); return result.changes === 1; }); }
  recoverOutbox() { this.db.prepare("UPDATE outbox SET state='retry',next_attempt_at=?,updated_at=? WHERE state='processing'").run(this.time(),this.time()); }
  getOutbox(id: string) { return this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as Record<string,unknown> | undefined; }
  completeOutbox(id: string, externalId: string | null) { this.tx(() => { this.db.prepare("UPDATE outbox SET state='done',external_id=?,last_error=NULL,updated_at=? WHERE id=?").run(externalId,this.time(),id); }); }
  failOutbox(id: string, error: string, terminal = false) { const at = this.now(); const next = new Date(at.getTime()+Math.min(60000,2000*2**Math.min(5,Number((this.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(id) as {attempts:number}).attempts)))).toISOString(); this.tx(() => { this.db.prepare("UPDATE outbox SET state=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?").run(terminal?'failed':'retry',terminal?this.time():next,error.slice(0,1000),this.time(),id); }); }
  acknowledgeConversation(id: string, answer: string) { this.tx(() => { this.db.prepare("UPDATE conversations SET answer=?,updated_at=?,revision=revision+1 WHERE id=? AND status='accepted'").run(answer,this.time(),id); this.event('conversation.acknowledged',id,'agent','agent',null,{ answer },OWNER_ID,true); }); this.changed(); }
  setConversationSession(id: string, sessionId: string) { this.tx(() => { this.db.prepare("UPDATE conversations SET session_id=?,status='running',updated_at=?,revision=revision+1 WHERE id=? AND status='accepted'").run(sessionId,this.time(),id); this.event('conversation.dispatched',id,'system','timer',null,{ sessionId }); }); this.changed(); }
  settleConversation(id: string, outcome: 'answered'|'failed'|'cancelled', text: string) { this.tx(() => { this.db.prepare('UPDATE conversations SET status=?,answer=?,error=?,updated_at=?,revision=revision+1 WHERE id=?').run(outcome,outcome === 'answered' ? text : '',outcome === 'answered' ? null : text,this.time(),id); this.event(`conversation.${outcome}`,id,'system','timer',null,{ outcome },OWNER_ID,true); }); this.changed(); }
  schedulerDelivery(aggregateId: string) { return (this.db.prepare("SELECT external_id FROM delivery WHERE aggregate_id=? AND kind='schedule'").get(aggregateId) as { external_id: string } | undefined)?.external_id ?? null; }
  schedulerSession(aggregateId: string) { return (this.db.prepare("SELECT external_id FROM delivery WHERE aggregate_id=? AND kind='session'").get(aggregateId) as { external_id: string } | undefined)?.external_id ?? null; }
  attachDshSchedule(id: string, dshScheduleId: string, sessionId: string) { this.tx(() => { this.db.prepare('UPDATE schedules SET dsh_schedule_id=? WHERE id=?').run(dshScheduleId,id); this.db.prepare("INSERT INTO delivery VALUES(?, 'schedule', ?, ?, ?, ?) ON CONFLICT(aggregate_id,kind) DO UPDATE SET external_id=excluded.external_id,updated_at=excluded.updated_at").run(id,`${sessionId}:${dshScheduleId}`,OWNER_ID,this.time(),this.time()); }); }
  recordSchedulerSession(aggregateId: string, sessionId: string) { this.db.prepare("INSERT INTO delivery VALUES(?, 'session', ?, ?, ?, ?) ON CONFLICT(aggregate_id,kind) DO UPDATE SET external_id=excluded.external_id,updated_at=excluded.updated_at").run(aggregateId,sessionId,OWNER_ID,this.time(),this.time()); }
}
