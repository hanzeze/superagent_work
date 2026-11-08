/** Transport-independent contracts shared by Host tools, Remote and the App. */
export const OWNER_ID = 'personal-owner';
export type Source = 'app' | 'agent' | 'timer' | 'test';
export type TaskStatus = 'inbox' | 'active' | 'blocked' | 'done' | 'cancelled';
export type Milestone = { text: string; done: boolean };
export type Task = {
  id: string; title: string; notes: string; status: TaskStatus; ownerId: string;
  nextStep: string; blocker: string; milestones: Milestone[];
  createdAt: string; updatedAt: string; completedAt: string | null; revision: number;
};
export type Schedule = {
  id: string; title: string; startAt: string; endAt: string | null; timeZone: string;
  notes: string; taskId: string | null; state: 'active' | 'cancelled';
  dshScheduleId: string | null; ownerId: string; createdAt: string; updatedAt: string; revision: number;
};
export type Event = {
  seq: number; id: string; kind: string; aggregateId: string; actorId: string; source: Source;
  commandId: string | null; at: string; payload: Record<string, unknown>;
};
export type Conversation = {
  id: string; sessionId: string | null; content: string; status: 'accepted' | 'running' | 'answered' | 'failed' | 'cancelled';
  answer: string; error: string | null; ownerId: string; createdAt: string; updatedAt: string; revision: number;
};
export type Snapshot = {
  revision: number; ownerId: string; serverTime: string;
  tasks: Task[]; schedules: Schedule[]; conversations: Conversation[]; events: Event[];
  reminders: unknown[];
  counts: { active: number; done: number; upcoming: number; pending: number };
  capabilities: { agent: boolean; delivery: 'in-app'; background: boolean; steer: 'step-boundary' };
};
export type TaskInput = { title: string; notes?: string; status?: TaskStatus; nextStep?: string; blocker?: string; milestones?: Milestone[] };
export type ScheduleInput = { title: string; startAt: string; endAt?: string | null; timeZone: string; notes?: string; taskId?: string | null };
export type Command = {
  commandId: string; actorId: string; source: Source; expectedRevision: number;
} & (
  | { kind: 'task.create'; input: TaskInput }
  | { kind: 'task.update'; id: string; input: Partial<TaskInput>; expectedRevision: number }
  | { kind: 'schedule.create'; input: ScheduleInput }
  | { kind: 'schedule.update'; id: string; input: Partial<ScheduleInput & { state: 'active' | 'cancelled' }>; expectedRevision: number }
  | { kind: 'conversation.create'; content: string }
  | { kind: 'conversation.control'; id: string; action: 'cancel' }
);
export type CommandResult = { accepted: true; id: string; revision: number; snapshot: Snapshot };
export class DomainError extends Error {
  readonly code: 'invalid' | 'conflict' | 'not_found' | 'forbidden';
  constructor(code: 'invalid' | 'conflict' | 'not_found' | 'forbidden', message: string) { super(message); this.code = code; this.name = 'DomainError'; }
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };
