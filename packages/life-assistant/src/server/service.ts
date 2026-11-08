import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { Context } from '@deepseek-ai/cordis';
import { LifeStore } from './store.ts';
import { DomainError, OWNER_ID } from '../contract.ts';
import type { Command, Snapshot } from '../contract.ts';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: Record<string,unknown> } };
type StreamFrame = { type: 'open'|'snapshot'|'keepalive'; snapshot?: Snapshot; revision?: number };
type SessionService = { create(request: { cwd: string }): Promise<{sessionId:string}>; prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type:'text';text:string }[]; clientTimeZone: string }): Promise<{accepted:true}>; follow(request: { address: { kind: 'session'; sessionId: string }; maxMessages: number }, signal?: AbortSignal): AsyncIterable<Record<string,unknown>> & { return?: () => Promise<unknown> }; cancel(request: { sessionId: string }): Promise<unknown> };
type ScheduleService = { create(sessionId: string, request: { title: string; prompt: string; at: string }, signal?: AbortSignal): Promise<{ id: string }>; delete(request: { id: string; sessionId: string }, signal?: AbortSignal): Promise<{ deleted: boolean }> };

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value });
function errorValue(error: unknown) { const e = error instanceof DomainError ? error : new DomainError('invalid',error instanceof Error ? error.message : 'Request failed'); return { ok:false as const,error:{code:e.code,message:e.message,details:{}} }; }
function wait(milliseconds: number, signal?: AbortSignal) { return new Promise<void>((resolve,reject) => { const timer = setTimeout(resolve,milliseconds); signal?.addEventListener('abort',() => { clearTimeout(timer); reject(new Error('Cancelled')); },{once:true}); }); }
function textOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''; const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => typeof part === 'object' && part !== null && (part as {type?:unknown}).type === 'text').map(part => String((part as {text?:unknown}).text ?? '')).join('');
  return '';
}
function commandInput(args: Record<string,unknown>, kind: Command['kind'], expectedRevision = 0): Command {
  const { commandId, ...rest } = args;
  return { kind, commandId: typeof commandId === 'string' && commandId ? commandId : randomUUID(), actorId:'agent', source:'agent', expectedRevision, ...rest } as Command;
}

export interface LifeConfig { databasePath?: string; cwd?: string }
export class LifeAssistantService extends TypertRemoteService {
  static inject = ['sessionController','tools','schedule'];
  readonly store: LifeStore;
  readonly cwd: string;
  private running = new Map<string,AbortController>();
  private watchers = new Set<() => void>();
  private worker: Promise<void> | undefined;
  private disposed = false;
  constructor(ctx: Context, config: LifeConfig = {}) {
    super(ctx,'life',{namespace:'life'});
    this.store = new LifeStore(config.databasePath ?? join(homedir(),'.dsh','life-assistant','life.db'));
    this.cwd = config.cwd ?? process.cwd();
    this.ctx.effect(() => () => this.dispose(),'life-assistant: durable service');
    this.store.subscribe(() => { for (const notify of this.watchers) notify(); });
    this.store.recoverOutbox();
    this.registerTools();
    this.worker = this.pump();
  }
  @Remote
  snapshot(request: Record<string,never>): Snapshot { void request; return this.store.snapshot(); }
  @Remote
  execute(request: { command: Command }): ReturnType<LifeStore['execute']> {
    return this.store.execute({ ...request.command, actorId: OWNER_ID, source:'app' });
  }
  @Remote
  async cancel(request: { id: string; expectedRevision: number }): Promise<{accepted:true}> {
    const result = this.store.execute({kind:'conversation.control',id:request.id,commandId:`cancel-${request.id}-${randomUUID()}`,actorId:OWNER_ID,source:'app',expectedRevision:request.expectedRevision,action:'cancel'});
    this.running.get(result.id)?.abort(); return {accepted:true};
  }
  @Remote({ mode: 'stream' })
  async *subscribe(request: Record<string,never>, signal: AbortSignal): AsyncGenerator<StreamFrame> {
    void request; let revision = -1; let notify = () => {};
    this.watchers.add(notify);
    try {
      yield { type:'open', snapshot:this.store.snapshot() };
      while (!signal.aborted && !this.disposed) {
        const current = this.store.snapshot();
        if (current.revision !== revision) { revision = current.revision; yield {type:'snapshot',snapshot:current}; }
        else yield {type:'keepalive',revision};
        await new Promise<void>(resolve => { const timer = setTimeout(resolve,5000); notify = () => { clearTimeout(timer); resolve(); }; signal.addEventListener('abort',() => { clearTimeout(timer); resolve(); },{once:true}); });
      }
    } finally { this.watchers.delete(notify); }
  }
  private async pump() {
    while (!this.disposed) {
      const jobs = this.store.readyOutbox();
      if (!jobs.length) { await wait(2000); continue; }
      await Promise.allSettled(jobs.map(async row => {
        const id = String(row.id); if (!this.store.claimOutbox(id)) return;
        if (row.kind === 'conversation.create') await this.dispatchConversation(id,row);
        else if (String(row.kind).startsWith('schedule.')) await this.syncSchedule(id,row);
        else if (row.kind === 'conversation.settled') await this.settleVisible(id,row);
      }));
    }
  }
  private async dispatchConversation(outboxId: string, row: Record<string,unknown>) {
    const id = String(row.aggregate_id); const controller = new AbortController(); this.running.set(id,controller);
    try {
      const conversation = this.store.snapshot().conversations.find(c => c.id === id);
      if (!conversation || conversation.status === 'cancelled') { this.store.completeOutbox(outboxId,null); return; }
      const service = this.ctx.get('sessionController') as unknown as SessionService;
      const created = await service.create({cwd:this.cwd});
      const sessionId = created.sessionId; this.store.setConversationSession(id,sessionId);
      await service.prompt({requestId:`life-${id}`,sessionId,mode:'queue',content:[{type:'text',text:conversation.content}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
      const stream = service.follow({address:{kind:'session',sessionId},maxMessages:80},controller.signal); controller.signal.addEventListener('abort',() => { void stream.return?.(); void service.cancel({sessionId}); },{once:true});
      let answer = '';
      for await (const frame of stream) {
        if (frame.type === 'snapshot') {
          for (const record of (frame.records ?? []) as Record<string,unknown>[]) {
            const event = (record.event ?? record) as {type?:string;data?:unknown};
            if (event.type === 'assistant/message') answer = textOf((event.data as {message?:unknown})?.message);
          }
          continue;
        }
        if (frame.type !== 'event') continue;
        const event = frame.event as {type?:string;data?:unknown};
        if (event.type === 'assistant/message') {
          const data = event.data as {message?:unknown}; const text = textOf(data.message); if (text) answer = text;
        } else if (event.type === 'turn/end') {
          const reason = (event.data as {reason?:{kind?:string}}).reason?.kind;
          if (answer) { this.store.settleConversation(id,'answered',answer); this.store.completeOutbox(outboxId,sessionId); }
          else if (reason === 'cancelled') { this.store.settleConversation(id,'cancelled','Agent cancelled this turn.'); this.store.completeOutbox(outboxId,sessionId); }
          else throw new Error('The Agent ended without a visible answer.');
          break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted || this.store.snapshot().conversations.find(c => c.id === id)?.status === 'cancelled') this.store.completeOutbox(outboxId,null);
      else { this.store.failOutbox(outboxId,error instanceof Error ? error.message : String(error)); this.store.settleConversation(id,'failed','Agent 暂时不可用。消息已保留，可稍后重试；没有冒充完成。'); }
    } finally { this.running.delete(id); }
  }
  private async settleVisible(outboxId: string, row: Record<string,unknown>) {
    try { this.store.completeOutbox(outboxId,null); }
    catch (error) { this.store.failOutbox(outboxId,error instanceof Error ? error.message : String(error)); }
  }
  private async syncSchedule(outboxId: string, row: Record<string,unknown>) {
    const id = String(row.aggregate_id);
    const schedule = this.store.snapshot().schedules.find(s => s.id === id);
    const service = this.ctx.get('schedule') as ScheduleService | undefined;
    try {
      if (!schedule) { this.store.completeOutbox(outboxId,null); return; }
      if (!service) { this.store.failOutbox(outboxId,'No DSH Schedule service is available. The calendar fact is retained, but no reminder was claimed.'); return; }
      const existingDelivery = this.dbDelivery(id);
      let sessionId = existingDelivery?.split(':')[0];
      if (!sessionId) {
        const service = this.ctx.get('sessionController') as unknown as SessionService;
        const created = await service.create({cwd:this.cwd});
        sessionId = created.sessionId; this.store.recordSchedulerSession(id,sessionId);
      }
      if (schedule.state === 'cancelled') {
        if (schedule.dshScheduleId) await service.delete({id:schedule.dshScheduleId,sessionId});
        this.store.completeOutbox(outboxId,schedule.dshScheduleId); return;
      }
      if (!schedule.dshScheduleId) {
        const record = await service.create(sessionId,{title:schedule.title,prompt:`个人日程「${schedule.title}」已到期。${schedule.notes ? `备注：${schedule.notes}` : ''} 请使用 life_query 查看相关工作，提醒用户，并如实说明已保存与尚未完成的事项。`,at:schedule.startAt});
        this.store.attachDshSchedule(id,record.id,sessionId); this.store.completeOutbox(outboxId,record.id);
      } else {
        await service.delete({id:schedule.dshScheduleId,sessionId});
        const record = await service.create(sessionId,{title:schedule.title,prompt:`个人日程「${schedule.title}」已更新。请使用 life_query 查看最新工作，提醒用户，不要冒充外部送达。`,at:schedule.startAt});
        this.store.attachDshSchedule(id,record.id,sessionId); this.store.completeOutbox(outboxId,record.id);
      }
    } catch (error) { this.store.failOutbox(outboxId,error instanceof Error ? error.message : String(error)); }
  }
  private dbDelivery(id: string) { return this.store.schedulerDelivery(id); }
  private registerTools() {
    const output = { schema:{type:'object' as const,additionalProperties:true},render:(_args:unknown,value:unknown) => [{type:'text' as const,text:JSON.stringify(value)}] };
    const register = (name: string, description: string, parameters: Record<string,unknown>, action: (args:Record<string,unknown>) => unknown) => {
      this.ctx.tools.register(defineTool({name,description,parameters:parameters as never,output:output as never,execute:async (args:unknown,exec:{signal:AbortSignal}) => { exec.signal.throwIfAborted(); try { return await action(args as Record<string,unknown>); } catch (error) { return {error:error instanceof Error ? error.message:String(error)}; } }} as never));
    };
    register('life_query','读取个人工作、日程、进展与历史；不执行任务，不等待模型。参数 view 可选 tasks/schedules/history/conversations/all。',{view:{type:'string'}},args => { const snapshot = this.store.snapshot(); return args.view && args.view !== 'all' ? {...snapshot,view:args.view,items:(snapshot as unknown as Record<string,unknown>)[String(args.view)] ?? []} : snapshot; });
    register('life_task_upsert','创建或更新个人任务，与 App 共用命令、revision/CAS 和审计。修改必须传当前 revision；里程碑为 {text,done} 数组。',{id:{type:'string'},expectedRevision:{type:'number'},title:{type:'string'},status:{type:'string'},notes:{type:'string'},nextStep:{type:'string'},blocker:{type:'string'},milestones:{type:'array'},commandId:{type:'string'}},args => this.store.execute(commandInput(args,args.id ? 'task.update' : 'task.create')));
    register('life_schedule_upsert','创建或修改日程。startAt 用带时区偏移的 ISO 时间，timeZone 为 IANA 名称；修改需当前 revision。',{id:{type:'string'},expectedRevision:{type:'number'},title:{type:'string'},startAt:{type:'string'},endAt:{type:'string'},timeZone:{type:'string'},notes:{type:'string'},taskId:{type:'string'},state:{type:'string'},commandId:{type:'string'}},args => this.store.execute(commandInput(args,args.id ? 'schedule.update' : 'schedule.create')));
    register('life_conversation_cancel','取消一条已经持久化的个人助手对话；取消不回滚已经提交的任务或日程。',{id:{type:'string',required:true},expectedRevision:{type:'number',required:true}},async args => this.cancel({id:String(args.id),expectedRevision:Number(args.expectedRevision)}));
  }
  private dispose() { this.disposed = true; for (const controller of this.running.values()) controller.abort(); for (const notify of this.watchers) notify(); this.store.close(); }
}
export const inject = ['sessionController','tools','schedule'];
export function apply(ctx: Context, config?: LifeConfig) { ctx.plugin(LifeAssistantService,config); }
