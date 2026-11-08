import React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { OWNER_ID } from '../contract.ts';
import type { Command, CommandResult, Conversation, Milestone, Result, Schedule, Snapshot, Task, TaskStatus } from '../contract.ts';
import { LIFE_REMOTE } from '../remote.ts';
import './style.css';

type StreamFrame = { type: 'open' | 'snapshot'; snapshot: Snapshot } | { type: 'keepalive'; revision: number };
type LifeClient = {
  snapshot(request: Record<string, never>): Promise<Result<Snapshot>>;
  execute(request: { command: Command }): Promise<Result<CommandResult>>;
  cancel(request: { id: string; expectedRevision: number }): Promise<Result<{ accepted: boolean }>>;
  subscribe(request: Record<string, never>, signal?: AbortSignal): AsyncIterable<StreamFrame | Snapshot> & { dispose?: () => void; return?: () => Promise<unknown> };
};
type Tab = 'summary' | 'tasks' | 'calendar' | 'history';
type Toast = { tone: 'success' | 'error' | 'info'; text: string } | null;
type Connection = 'loading' | 'live' | 'polling' | 'reconnecting' | 'offline';
type Editor = { kind: 'task'; item?: Task } | { kind: 'schedule'; item?: Schedule } | null;
type EditorSubmit = (command: Command, success?: string) => Promise<boolean>;

const TIME_ZONE = 'Asia/Shanghai';
const STATUS: Record<TaskStatus, string> = { inbox: '待整理', active: '进行中', blocked: '有阻塞', done: '已完成', cancelled: '已取消' };
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'summary', label: '概览', icon: 'home' }, { id: 'tasks', label: '任务', icon: 'task' },
  { id: 'calendar', label: '日程', icon: 'calendar' }, { id: 'history', label: '历史', icon: 'history' },
];
const EVENT_LABELS: Record<string, string> = {
  'task.create': '创建了任务', 'task.update': '更新了任务', 'schedule.create': '创建了日程',
  'schedule.update': '更新了日程', 'conversation.create': '向小屿发送了消息',
  'conversation.control': '请求取消对话', 'conversation.dispatched': '小屿开始处理消息',
  'conversation.answered': '小屿完成了回复', 'conversation.failed': '消息处理失败', 'conversation.cancelled': '对话已取消',
};

type IconName = 'home' | 'task' | 'calendar' | 'history' | 'plus' | 'spark' | 'arrow' | 'next' | 'clock' | 'refresh' | 'edit' | 'close' | 'send' | 'chat' | 'check' | 'more' | 'search';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7"/></>,
    task: <><rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 9 1.5 1.5L12 8m-4 6 1.5 1.5L12 13m3-4h2m-2 5h2"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18M8 14h.01m4 0h.01m4 0h.01M8 17h.01m4 0h.01"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z"/></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>, next: <path d="m9 5 7 7-7 7"/>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M18.5 16a8 8 0 1 1 .8-7.8L20 12"/></>, edit: <><path d="m14 5 5 5M4 20l3.5-.8L19 7.7a2 2 0 0 0-2.8-2.8L4.8 16.4 4 20Z"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, send: <><path d="m21 3-7 18-3-8-8-3 18-7Z"/><path d="m11 13 5-5"/></>,
    chat: <><path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z"/><path d="M8 9h8m-8 4h5"/></>,
    check: <path d="m5 12 4 4L19 6"/>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  };
  return <svg className="pw-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function commandId() { return globalThis.crypto?.randomUUID?.() ?? `work-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '暂时无法连接小屿，请稍后重试。'; }
function dateValue(value: string) { return new Date(value); }
function formatDate(value: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, month: 'long', day: 'numeric', weekday: 'short', ...options }).format(dateValue(value));
}
function formatTime(value: string, zone = TIME_ZONE) { return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(dateValue(value)); }
function dayKey(value: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateValue(value)); }
function relativeDay(value: string, serverTime: string) {
  const diff = Math.round((Date.parse(`${dayKey(value)}T00:00:00+08:00`) - Date.parse(`${dayKey(serverTime)}T00:00:00+08:00`)) / 86400000);
  return diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : formatDate(value, { year: undefined });
}
function zonedInput(value: Date | string, zone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(typeof value === 'string' ? dateValue(value) : value);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}
function inputToIso(value: string, zone = TIME_ZONE) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let timestamp = desired;
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(timestamp));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
    const actual = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    timestamp += desired - actual;
  }
  return new Date(timestamp).toISOString();
}
function defaultStart() { const date = new Date(Date.now() + 3600000); date.setSeconds(0, 0); return zonedInput(date); }
function isSnapshotFrame(frame: StreamFrame | Snapshot): frame is StreamFrame { return 'type' in frame; }

function StatusPill({ status }: { status: TaskStatus }) { return <span className={`pw-status pw-status-${status}`}><i />{STATUS[status]}</span>; }
function Empty({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return <div className="pw-empty"><span className="pw-empty-icon"><Icon name={icon} size={25}/></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function Spinner() { return <span className="pw-spinner" aria-hidden="true"/>; }

function Modal({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panel.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus(), 20);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && panel.current) {
        const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'));
        if (!nodes.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  return <div className="pw-modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="pw-modal" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title" ref={panel}>
      <div className="pw-modal-head"><div><span className="pw-eyebrow">{eyebrow}</span><h2 id="pw-modal-title">{title}</h2></div><button className="pw-icon-button" onClick={onClose} aria-label="关闭对话框"><Icon name="close"/></button></div>
      {children}
    </div>
  </div>;
}

function TaskForm({ item, busy, onClose, onSubmit }: { item?: Task; busy: boolean; onClose: () => void; onSubmit: EditorSubmit }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [status, setStatus] = useState<TaskStatus>(item?.status ?? 'active');
  const [nextStep, setNextStep] = useState(item?.nextStep ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [blocker, setBlocker] = useState(item?.blocker ?? '');
  const [milestones, setMilestones] = useState<Milestone[]>(item?.milestones ?? []);
  const [newMilestone, setNewMilestone] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { title: title.trim(), status, nextStep: nextStep.trim(), notes: notes.trim() || undefined, blocker: blocker.trim() || undefined, milestones };
    const command: Command = item
      ? { kind: 'task.update', id: item.id, expectedRevision: item.revision, input, commandId: commandId(), actorId: OWNER_ID, source: 'app' }
      : { kind: 'task.create', expectedRevision: 0, input, commandId: commandId(), actorId: OWNER_ID, source: 'app' };
    void onSubmit(command).then(ok => { if (ok) onClose(); });
  };
  return <Modal title={item ? '编辑任务' : '创建一项任务'} eyebrow={item ? `版本 ${item.revision}` : '把想法变成清晰的下一步'} onClose={onClose}>
    <form className="pw-form" onSubmit={submit}>
      <label className="pw-field pw-field-full"><span>任务名称 <b>*</b></span><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：完成季度计划初稿"/></label>
      <div className="pw-form-grid">
        <label className="pw-field"><span>当前状态</span><select value={status} onChange={e => setStatus(e.target.value as TaskStatus)}>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="pw-field"><span>下一步</span><input maxLength={500} value={nextStep} onChange={e => setNextStep(e.target.value)} placeholder="一个具体、可执行的动作"/></label>
      </div>
      <label className="pw-field pw-field-full"><span>备注</span><textarea rows={3} maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="背景、交付标准或相关说明（选填）"/></label>
      <div className="pw-field pw-field-full"><span>里程碑</span><div className="pw-milestone-editor">
        {milestones.map((milestone, index) => <div className="pw-milestone-row" key={`${index}-${milestone.text}`}><label><input type="checkbox" checked={milestone.done} onChange={e => setMilestones(rows => rows.map((row, i) => i === index ? { ...row, done: e.target.checked } : row))}/><span>{milestone.text}</span></label><button type="button" className="pw-icon-button" aria-label={`删除里程碑 ${milestone.text}`} onClick={() => setMilestones(rows => rows.filter((_, i) => i !== index))}><Icon name="close" size={15}/></button></div>)}
        <div className="pw-add-milestone"><input aria-label="新里程碑" maxLength={300} value={newMilestone} onChange={e => setNewMilestone(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (newMilestone.trim()) { setMilestones(rows => [...rows, { text: newMilestone.trim(), done: false }]); setNewMilestone(''); } } }} placeholder="添加一个阶段性成果"/><button type="button" className="pw-button pw-button-quiet" disabled={!newMilestone.trim()} onClick={() => { setMilestones(rows => [...rows, { text: newMilestone.trim(), done: false }]); setNewMilestone(''); }}><Icon name="plus" size={16}/>添加</button></div>
      </div></div>
      <label className="pw-field pw-field-full"><span>阻塞说明</span><input maxLength={500} value={blocker} onChange={e => setBlocker(e.target.value)} placeholder="如果进展受阻，记录正在等待什么（选填）"/></label>
      <div className="pw-form-actions"><button type="button" className="pw-button pw-button-quiet" onClick={onClose}>取消</button><button className="pw-button pw-button-primary" disabled={busy || !title.trim()}>{busy ? <Spinner/> : <Icon name="check" size={17}/>} {item ? '保存更改' : '创建任务'}</button></div>
    </form>
  </Modal>;
}

function ScheduleForm({ item, tasks, busy, onClose, onSubmit }: { item?: Schedule; tasks: Task[]; busy: boolean; onClose: () => void; onSubmit: EditorSubmit }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [startAt, setStartAt] = useState(item ? zonedInput(item.startAt, item.timeZone) : defaultStart());
  const [endAt, setEndAt] = useState(item?.endAt ? zonedInput(item.endAt, item.timeZone) : '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [taskId, setTaskId] = useState(item?.taskId ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { title: title.trim(), startAt: inputToIso(startAt), endAt: endAt ? inputToIso(endAt) : null, timeZone: TIME_ZONE, notes: notes.trim() || undefined, taskId: taskId || null };
    const command: Command = item
      ? { kind: 'schedule.update', id: item.id, expectedRevision: item.revision, input, commandId: commandId(), actorId: OWNER_ID, source: 'app' }
      : { kind: 'schedule.create', expectedRevision: 0, input, commandId: commandId(), actorId: OWNER_ID, source: 'app' };
    void onSubmit(command).then(ok => { if (ok) onClose(); });
  };
  return <Modal title={item ? '编辑日程' : '安排一段时间'} eyebrow="中国标准时间 · UTC+08:00" onClose={onClose}>
    <form className="pw-form" onSubmit={submit}>
      <label className="pw-field pw-field-full"><span>日程名称 <b>*</b></span><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：产品周会"/></label>
      <div className="pw-form-grid">
        <label className="pw-field"><span>开始时间 <b>*</b></span><input required type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)}/></label>
        <label className="pw-field"><span>结束时间</span><input type="datetime-local" min={startAt} value={endAt} onChange={e => setEndAt(e.target.value)}/></label>
      </div>
      <div className="pw-timezone-note"><Icon name="clock" size={16}/><span>以上时间按 <strong>Asia/Shanghai</strong> 解释并显示，提交后保存为带时区的绝对时间。</span></div>
      <label className="pw-field pw-field-full"><span>关联任务</span><select value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">不关联任务</option>{tasks.filter(task => !['done', 'cancelled'].includes(task.status)).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label className="pw-field pw-field-full"><span>备注</span><textarea rows={3} maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="地点、会议链接或准备事项（选填）"/></label>
      <div className="pw-form-actions"><button type="button" className="pw-button pw-button-quiet" onClick={onClose}>取消</button><button className="pw-button pw-button-primary" disabled={busy || !title.trim() || !startAt}>{busy ? <Spinner/> : <Icon name="check" size={17}/>} {item ? '保存更改' : '创建日程'}</button></div>
    </form>
  </Modal>;
}

function TaskCard({ task, busy, onEdit, onCommand }: { task: Task; busy: boolean; onEdit: () => void; onCommand: (command: Command, success?: string) => Promise<boolean> }) {
  const done = task.milestones.filter(item => item.done).length;
  const update = (input: Partial<Pick<Task, 'status' | 'milestones'>>) => onCommand({ kind: 'task.update', id: task.id, expectedRevision: task.revision, input, commandId: commandId(), actorId: OWNER_ID, source: 'app' }, input.status === 'done' ? '任务已标记完成' : '任务已更新');
  return <article className={`pw-task-card ${task.status === 'done' ? 'is-done' : ''}`}>
    <div className="pw-task-top"><StatusPill status={task.status}/><button className="pw-icon-button" onClick={onEdit} aria-label={`编辑任务 ${task.title}`}><Icon name="edit" size={16}/></button></div>
    <h3>{task.title}</h3>
    {task.notes && <p className="pw-task-notes">{task.notes}</p>}
    {task.nextStep && <div className="pw-next-step"><span><Icon name="next" size={15}/></span><div><small>下一步</small><p>{task.nextStep}</p></div></div>}
    {task.blocker && <div className="pw-blocker"><span>阻塞</span>{task.blocker}</div>}
    {task.milestones.length > 0 && <div className="pw-task-milestones"><div className="pw-progress-label"><span>里程碑</span><span>{done} / {task.milestones.length}</span></div><div className="pw-progress"><i style={{ width: `${done / task.milestones.length * 100}%` }}/></div><div className="pw-milestone-list">{task.milestones.map((milestone, index) => <label key={`${index}-${milestone.text}`} className={milestone.done ? 'is-checked' : ''}><input type="checkbox" disabled={busy} checked={milestone.done} onChange={e => void update({ milestones: task.milestones.map((row, i) => i === index ? { ...row, done: e.target.checked } : row) })}/><span>{milestone.text}</span></label>)}</div></div>}
    <div className="pw-task-footer"><span title={task.updatedAt}>更新于 {formatDate(task.updatedAt, { weekday: undefined })}</span>{!['done', 'cancelled'].includes(task.status) && <button disabled={busy} className="pw-text-button" onClick={() => void update({ status: 'done' })}><Icon name="check" size={15}/>标记完成</button>}{task.status === 'done' && <button disabled={busy} className="pw-text-button" onClick={() => void update({ status: 'active' })}>重新打开</button>}</div>
  </article>;
}

function ScheduleItem({ schedule, serverTime, busy, onEdit, onCancel, onRestore }: { schedule: Schedule; serverTime: string; busy: boolean; onEdit: () => void; onCancel: () => void; onRestore: () => void }) {
  return <article className={`pw-schedule-item ${schedule.state === 'cancelled' ? 'is-cancelled' : ''}`}>
    <div className="pw-schedule-date"><strong>{new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, day: '2-digit' }).format(dateValue(schedule.startAt))}</strong><span>{new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, month: 'short' }).format(dateValue(schedule.startAt))}</span></div>
    <div className="pw-schedule-line"><i/></div>
    <div className="pw-schedule-main"><div className="pw-schedule-meta"><span>{relativeDay(schedule.startAt, serverTime)}</span><span>{formatTime(schedule.startAt)}{schedule.endAt ? ` – ${formatTime(schedule.endAt)}` : ''}</span>{schedule.state === 'cancelled' && <span className="pw-cancelled-label">已取消</span>}</div><h3>{schedule.title}</h3>{schedule.notes && <p>{schedule.notes}</p>}<small>{schedule.timeZone === TIME_ZONE ? 'Asia/Shanghai · UTC+08:00' : schedule.timeZone}</small></div>
    <div className="pw-schedule-actions"><button className="pw-icon-button" onClick={onEdit} aria-label={`编辑日程 ${schedule.title}`}><Icon name="edit" size={16}/></button>{schedule.state === 'active' ? <button className="pw-text-button pw-danger" disabled={busy} onClick={onCancel}>取消日程</button> : <button className="pw-text-button" disabled={busy} onClick={onRestore}>恢复</button>}</div>
  </article>;
}

function ConversationStatus({ conversation }: { conversation: Conversation }) {
  if (conversation.status === 'accepted') return <span className="pw-conversation-status"><i/>已收到，等待后台处理</span>;
  if (conversation.status === 'running') return <span className="pw-conversation-status is-running"><Spinner/>小屿正在处理</span>;
  if (conversation.status === 'failed') return <span className="pw-conversation-status is-failed">处理失败 · 消息已保留</span>;
  if (conversation.status === 'cancelled') return <span className="pw-conversation-status">已取消</span>;
  return null;
}

function ChatPanel({ snapshot, draft, setDraft, busy, mobile, onClose, onSend, onCancel }: { snapshot: Snapshot | null; draft: string; setDraft: (value: string) => void; busy: boolean; mobile?: boolean; onClose?: () => void; onSend: (content: string) => void; onCancel: (conversation: Conversation) => void }) {
  const inputId = `pw-chat-${useId().replace(/:/g, '')}`;
  const scroll = useRef<HTMLDivElement>(null);
  const conversations = useMemo(() => [...(snapshot?.conversations ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)), [snapshot?.conversations]);
  useEffect(() => { const node = scroll.current; if (node) node.scrollTop = node.scrollHeight; }, [conversations.length, conversations.at(-1)?.updatedAt]);
  const send = (event: FormEvent) => { event.preventDefault(); if (draft.trim()) onSend(draft.trim()); };
  return <section className={`pw-chat ${mobile ? 'pw-chat-mobile' : ''}`} aria-label="与小屿对话">
    <header className="pw-chat-head"><div className="pw-avatar"><span>屿</span><i/></div><div><h2>小屿</h2><p>{snapshot?.capabilities.background ? '持续在线 · 后台处理' : '个人生活助手'}</p></div>{mobile && <button className="pw-icon-button" onClick={onClose} aria-label="收起对话"><Icon name="close"/></button>}</header>
    <div className="pw-chat-messages" ref={scroll} aria-live="polite">
      <div className="pw-welcome"><span className="pw-welcome-mark"><Icon name="spark" size={22}/></span><h3>今天想先处理什么？</h3><p>我会记住你的消息，并在后台处理。你可以随时离开，稍后回来查看进展。</p></div>
      {conversations.length === 0 && <div className="pw-quick-actions"><button onClick={() => onSend('请查看我当前的任务和下一步。')}>查看当前工作<Icon name="arrow" size={14}/></button><button onClick={() => onSend('请告诉我接下来的日程安排。')}>接下来有什么安排<Icon name="arrow" size={14}/></button></div>}
      {conversations.map(conversation => <div className="pw-message-group" key={conversation.id}><div className="pw-message pw-message-user">{conversation.content}</div><div className="pw-message-time">{formatDate(conversation.createdAt, { month: 'numeric', day: 'numeric', weekday: undefined })} {formatTime(conversation.createdAt)}</div>{conversation.answer ? <div className="pw-message pw-message-agent">{conversation.answer}</div> : <div className="pw-message pw-message-agent pw-message-pending"><ConversationStatus conversation={conversation}/>{conversation.error && conversation.status === 'failed' && <p>{conversation.error}</p>}{['accepted', 'running'].includes(conversation.status) && <button className="pw-text-button" disabled={busy} onClick={() => onCancel(conversation)}>取消处理</button>}</div>}</div>)}
    </div>
    <div className="pw-chat-compose"><form onSubmit={send}><label htmlFor={inputId} className="pw-sr-only">发送给小屿的消息</label><textarea id={inputId} rows={2} maxLength={12000} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim() && !busy) onSend(draft.trim()); } }} placeholder="告诉小屿你想做什么…"/><button className="pw-send" disabled={busy || !draft.trim()} aria-label="发送消息">{busy ? <Spinner/> : <Icon name="send" size={18}/>}</button></form><p>Enter 发送 · Shift + Enter 换行 <span>消息会持久保存</span></p></div>
  </section>;
}

function WorkApp({ life }: { life: LifeClient }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [tab, setTab] = useState<Tab>('summary');
  const [editor, setEditor] = useState<Editor>(null);
  const [taskFilter, setTaskFilter] = useState<'current' | TaskStatus | 'all'>('current');
  const [query, setQuery] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [cancelSchedule, setCancelSchedule] = useState<Schedule | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [busy, setBusy] = useState(0);
  const [chatBusy, setChatBusy] = useState(0);
  const chatPending = useRef(false);
  const [toast, setToast] = useState<Toast>(null);
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem('personal-work.chat-draft') ?? ''; } catch { return ''; } });
  const snapshotRef = useRef<Snapshot | null>(null);
  const toastTimer = useRef<number>();
  const refreshSequence = useRef(0);
  const notify = useCallback((text: string, tone: NonNullable<Toast>['tone'] = 'info') => { window.clearTimeout(toastTimer.current); setToast({ text, tone }); toastTimer.current = window.setTimeout(() => setToast(null), tone === 'error' ? 8000 : 4500); }, []);
  const applySnapshot = useCallback((next: Snapshot) => {
    if (next && Array.isArray(next.tasks) && Array.isArray(next.schedules)) {
      setSnapshot(current => current && next.revision < current.revision ? current : next);
      snapshotRef.current = next;
    }
  }, []);
  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++refreshSequence.current;
    try {
      const result = await life.snapshot({});
      if (sequence !== refreshSequence.current) return false;
      if (result.ok) { applySnapshot(result.value); setConnection(navigator.onLine ? 'live' : 'offline'); return true; }
      if (!quiet) notify(result.error.message, 'error');
      setConnection(navigator.onLine ? 'reconnecting' : 'offline');
      return false;
    } catch (error) { if (!quiet) notify(errorMessage(error), 'error'); setConnection(navigator.onLine ? 'reconnecting' : 'offline'); return false; }
  }, [life, applySnapshot, notify]);

  useEffect(() => {
    let stopped = false, controller = new AbortController(), retry: number | undefined;
    const listen = async () => {
      while (!stopped) {
        controller = new AbortController();
        let stream: ReturnType<LifeClient['subscribe']> | undefined;
        try {
          stream = life.subscribe({}, controller.signal);
          for await (const frame of stream) {
            if (stopped) break;
            const next = isSnapshotFrame(frame) ? (frame.type === 'keepalive' ? null : frame.snapshot) : frame;
            if (next) applySnapshot(next);
            setConnection(navigator.onLine ? 'live' : 'offline');
          }
          if (!stopped) throw new Error('实时连接已结束');
        } catch {
          if (!stopped) { setConnection(navigator.onLine ? 'reconnecting' : 'offline'); await refresh(true); }
        } finally { stream?.dispose?.(); }
        if (!stopped) await new Promise<void>(resolve => { retry = window.setTimeout(resolve, 4000); });
      }
    };
    void refresh(true);
    void listen();
    const poll = window.setInterval(() => { if (navigator.onLine) void refresh(true); }, 20000);
    const online = () => { setConnection('reconnecting'); void refresh(true); };
    const offline = () => setConnection('offline');
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    return () => { stopped = true; controller.abort(); window.clearTimeout(retry); window.clearInterval(poll); window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, [life, refresh, applySnapshot]);

  useEffect(() => { try { if (draft) localStorage.setItem('personal-work.chat-draft', draft); else localStorage.removeItem('personal-work.chat-draft'); } catch { /* Draft persistence is optional. */ } }, [draft]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  useEffect(() => {
    if (!chatOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setChatOpen(false); };
    const drawer = document.querySelector<HTMLElement>('.pw-chat-drawer');
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => drawer?.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 20);
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = Array.from(drawer?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
      const first = nodes[0], last = nodes.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', close); document.addEventListener('keydown', trap);
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', close); document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [chatOpen]);

  const execute = useCallback(async (command: Command, success = '更改已生效') => {
    setBusy(value => value + 1);
    try {
      const result = await life.execute({ command });
      if (!result.ok) {
        if (result.error.message.toLowerCase().includes('conflict') || result.error.message.includes('changed') || result.error.message.includes('revision')) { notify('内容已在其他入口更新。已刷新最新数据，请核对后重试。', 'error'); await refresh(true); }
        else notify(result.error.message, 'error');
        return false;
      }
      applySnapshot(result.value.snapshot); notify(success, 'success'); return true;
    } catch (error) { notify(errorMessage(error), 'error'); return false; }
    finally { setBusy(value => Math.max(0, value - 1)); }
  }, [life, notify, refresh, applySnapshot]);

  const submitEditor = useCallback((command: Command, success?: string) => {
    if ((command.kind === 'task.create' || command.kind === 'schedule.create') && snapshotRef.current && snapshotRef.current.revision !== command.expectedRevision) {
      notify('工作空间已有新更改，请核对最新内容后重新提交。', 'error');
      void refresh(true);
      return Promise.resolve(false);
    }
    return execute(command, success);
  }, [execute, notify, refresh]);

  const sendChat = useCallback(async (content: string) => {
    if (chatPending.current) return;
    chatPending.current = true;
    setChatBusy(1);
    setDraft('');
    notify('已收到，正在后台处理', 'info');
    const command: Command = { kind: 'conversation.create', content, expectedRevision: snapshotRef.current?.revision ?? 0, commandId: commandId(), actorId: OWNER_ID, source: 'app' };
    const ok = await execute(command, '消息已保存，小屿正在后台处理');
    if (!ok) setDraft(current => current || content);
    chatPending.current = false;
    setChatBusy(0);
  }, [execute, notify]);
  const cancelConversation = useCallback(async (conversation: Conversation) => {
    setBusy(value => value + 1);
    try {
      const result = await life.cancel({ id: conversation.id, expectedRevision: conversation.revision });
      if (result.ok) { notify('取消请求已生效；已提交的更改不会回滚。', 'success'); await refresh(true); }
      else { notify(result.error.message, 'error'); await refresh(true); }
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(value => Math.max(0, value - 1)); }
  }, [life, notify, refresh]);

  const tasks = useMemo(() => (snapshot?.tasks ?? []).filter(task => {
    if (query && !`${task.title} ${task.notes} ${task.nextStep}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (taskFilter === 'current') return !['done', 'cancelled'].includes(task.status);
    if (taskFilter === 'all') return true;
    return task.status === taskFilter;
  }), [snapshot?.tasks, taskFilter, query]);
  const schedules = useMemo(() => [...(snapshot?.schedules ?? [])].filter(item => showCancelled || item.state === 'active').sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)), [snapshot?.schedules, showCancelled]);
  const upcoming = useMemo(() => schedules.filter(item => item.state === 'active' && Date.parse(item.startAt) >= Date.now() - 3600000), [schedules]);
  const focusTasks = useMemo(() => (snapshot?.tasks ?? []).filter(task => ['active', 'blocked'].includes(task.status)), [snapshot?.tasks]);
  const serverTime = snapshot?.serverTime ?? new Date().toISOString();
  const hasFacts = Boolean(snapshot && (snapshot.tasks.length || snapshot.schedules.length || snapshot.conversations.length || snapshot.events.length));
  const isBusy = busy > 0;
  const isChatBusy = isBusy || chatBusy > 0;
  const closeEditor = useCallback(() => setEditor(null), []);
  const connectionLabel = { loading: '正在连接', live: '已同步', polling: '定时同步', reconnecting: '重新连接中', offline: '当前离线' }[connection];

  return <div className="personal-work">
    <a className="pw-skip" href={`#pw-panel-${tab}`}>跳到主要内容</a>
    <header className="pw-header"><div className="pw-brand"><span className="pw-brand-symbol"><i/><i/><i/></span><div><h1>小屿 <span>Work</span></h1><p>把生活与工作，安放在同一座岛屿。</p></div></div><div className="pw-header-actions"><div className={`pw-connection pw-connection-${connection}`} role="status"><i/>{connectionLabel}</div><button className="pw-icon-button" onClick={() => void refresh()} disabled={connection === 'loading'} aria-label="刷新数据" title="刷新数据"><Icon name="refresh"/></button><button className="pw-button pw-button-primary pw-new-task" onClick={() => setEditor({ kind: 'task' })}><Icon name="plus" size={17}/>新建任务</button></div></header>
    <nav className="pw-tabs" aria-label="Work 页面导航" role="tablist">{TABS.map(item => <button key={item.id} role="tab" id={`pw-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`pw-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}><Icon name={item.icon} size={17}/><span>{item.label}</span>{item.id === 'tasks' && snapshot ? <small>{snapshot.counts.active}</small> : null}</button>)}<span className="pw-tab-spacer"/><button className="pw-button pw-button-quiet pw-new-schedule" onClick={() => setEditor({ kind: 'schedule' })}><Icon name="plus" size={16}/>安排日程</button></nav>
    {connection === 'offline' && <div className="pw-banner" role="alert"><span>当前处于离线状态。展示的是最后一次同步的数据，新的更改需要联网后重试。</span><button onClick={() => void refresh()}>重新连接</button></div>}
    <div className="pw-layout">
      <main id={`pw-panel-${tab}`} className="pw-main" role="tabpanel" aria-labelledby={`pw-tab-${tab}`}>
        {connection === 'loading' && !snapshot ? <div className="pw-loading"><Spinner/><p>正在读取你的共享工作空间…</p></div> : <>
          {tab === 'summary' && <div className="pw-view pw-summary-view">
            <section className="pw-hero"><div><span className="pw-eyebrow">{formatDate(serverTime, { year: 'numeric' })}</span><h2>让每一步，都清晰可循。</h2><p>{snapshot?.counts.pending ? `小屿正在后台处理 ${snapshot.counts.pending} 条消息，你可以安心继续手头的事。` : '从一个具体的下一步开始，不必一次做完所有事。'}</p><button className="pw-button pw-button-coral" onClick={() => setEditor({ kind: 'task' })}>记录一件事<Icon name="arrow" size={17}/></button></div><div className="pw-hero-art" aria-hidden="true"><span className="pw-sun"/><span className="pw-island"><i/><i/><i/></span><span className="pw-water one"/><span className="pw-water two"/></div></section>
            {!hasFacts ? <Empty icon="spark" title="这座岛屿，等你写下第一笔" text="还没有任务、日程或对话。你可以直接创建，也可以把想法告诉小屿；这里不会预填任何私人数据。" action={<div className="pw-empty-actions"><button className="pw-button pw-button-primary" onClick={() => setEditor({ kind: 'task' })}><Icon name="plus" size={16}/>创建任务</button><button className="pw-button pw-button-quiet" onClick={() => setChatOpen(true)}><Icon name="chat" size={16}/>和小屿聊聊</button></div>}/> : <>
              <section className="pw-stats" aria-label="工作统计"><button onClick={() => { setTaskFilter('current'); setTab('tasks'); }}><span className="pw-stat-icon green"><Icon name="task"/></span><div><strong>{snapshot?.counts.active ?? 0}</strong><span>进行中的任务</span></div><Icon name="next" size={15}/></button><button onClick={() => setTab('calendar')}><span className="pw-stat-icon coral"><Icon name="calendar"/></span><div><strong>{snapshot?.counts.upcoming ?? 0}</strong><span>即将到来的日程</span></div><Icon name="next" size={15}/></button><button onClick={() => setChatOpen(true)}><span className="pw-stat-icon sand"><Icon name="chat"/></span><div><strong>{snapshot?.counts.pending ?? 0}</strong><span>后台处理中</span></div><Icon name="next" size={15}/></button></section>
              <div className="pw-dashboard-grid"><section className="pw-section"><div className="pw-section-head"><div><span className="pw-eyebrow">FOCUS</span><h2>此刻值得关注</h2></div><button className="pw-text-button" onClick={() => setTab('tasks')}>全部任务<Icon name="arrow" size={15}/></button></div>{focusTasks.length ? <div className="pw-task-grid">{focusTasks.slice(0, 2).map(task => <TaskCard key={task.id} task={task} busy={isBusy} onEdit={() => setEditor({ kind: 'task', item: task })} onCommand={execute}/>)}</div> : <Empty icon="task" title="当前没有进行中的任务" text="创建任务并写下一步，让工作开始流动。"/>}</section>
              <section className="pw-section pw-upcoming"><div className="pw-section-head"><div><span className="pw-eyebrow">UP NEXT</span><h2>接下来</h2></div><button className="pw-text-button" onClick={() => setTab('calendar')}>查看日程<Icon name="arrow" size={15}/></button></div>{upcoming.length ? upcoming.slice(0, 3).map(schedule => <ScheduleItem key={schedule.id} schedule={schedule} serverTime={serverTime} busy={isBusy} onEdit={() => setEditor({ kind: 'schedule', item: schedule })} onCancel={() => setCancelSchedule(schedule)} onRestore={() => void execute({ kind: 'schedule.update', id: schedule.id, expectedRevision: schedule.revision, input: { state: 'active' }, commandId: commandId(), actorId: OWNER_ID, source: 'app' }, '日程已恢复')}/>) : <Empty icon="calendar" title="近期没有日程" text="为重要的事留出一段从容的时间。" action={<button className="pw-text-button" onClick={() => setEditor({ kind: 'schedule' })}>安排日程<Icon name="plus" size={14}/></button>}/>}</section></div>
            </>}
          </div>}
          {tab === 'tasks' && <div className="pw-view"><div className="pw-view-head"><div><span className="pw-eyebrow">TASKS</span><h2>每一项，都有下一步</h2><p>状态与进展来自共享工作空间，不依赖页面里的临时记录。</p></div><button className="pw-button pw-button-primary" onClick={() => setEditor({ kind: 'task' })}><Icon name="plus" size={17}/>新建任务</button></div><div className="pw-toolbar"><div className="pw-filter-chips" aria-label="筛选任务">{([['current', '当前'], ['active', '进行中'], ['blocked', '有阻塞'], ['inbox', '待整理'], ['done', '已完成'], ['all', '全部']] as const).map(([key, label]) => <button className={taskFilter === key ? 'is-active' : ''} key={key} onClick={() => setTaskFilter(key)}>{label}</button>)}</div><label className="pw-search"><Icon name="search" size={16}/><span className="pw-sr-only">搜索任务</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索任务"/></label></div>{tasks.length ? <div className="pw-task-grid pw-task-grid-full">{tasks.map(task => <TaskCard key={task.id} task={task} busy={isBusy} onEdit={() => setEditor({ kind: 'task', item: task })} onCommand={execute}/>)}</div> : <Empty icon="task" title={query ? '没有匹配的任务' : '这里还很安静'} text={query ? '试试其他关键词，或清空筛选条件。' : '创建一项任务，把模糊的想法变成清晰的行动。'} action={!query ? <button className="pw-button pw-button-primary" onClick={() => setEditor({ kind: 'task' })}>创建任务</button> : undefined}/>}</div>}
          {tab === 'calendar' && <div className="pw-view"><div className="pw-view-head"><div><span className="pw-eyebrow">CALENDAR</span><h2>为重要的事，留出时间</h2><p>所有时间默认使用 Asia/Shanghai（UTC+08:00）显示。</p></div><button className="pw-button pw-button-primary" onClick={() => setEditor({ kind: 'schedule' })}><Icon name="plus" size={17}/>新建日程</button></div><div className="pw-toolbar"><span className="pw-calendar-caption">日程安排</span><label className="pw-toggle"><input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)}/><span>显示已取消</span></label></div>{schedules.length ? <div className="pw-schedule-list">{schedules.map(schedule => <ScheduleItem key={schedule.id} schedule={schedule} serverTime={serverTime} busy={isBusy} onEdit={() => setEditor({ kind: 'schedule', item: schedule })} onCancel={() => setCancelSchedule(schedule)} onRestore={() => void execute({ kind: 'schedule.update', id: schedule.id, expectedRevision: schedule.revision, input: { state: 'active' }, commandId: commandId(), actorId: OWNER_ID, source: 'app' }, '日程已恢复')}/>)}</div> : <Empty icon="calendar" title="还没有日程" text="从一次会议、一段专注时间，或一个重要的约定开始。" action={<button className="pw-button pw-button-primary" onClick={() => setEditor({ kind: 'schedule' })}>安排日程</button>}/>}</div>}
          {tab === 'history' && <div className="pw-view"><div className="pw-view-head"><div><span className="pw-eyebrow">ACTIVITY</span><h2>每一步，都有迹可循</h2><p>来自任务、日程和对话的持久事件，不是页面浏览记录。</p></div><button className="pw-icon-button" aria-label="刷新历史" onClick={() => void refresh()}><Icon name="refresh"/></button></div>{snapshot?.events.length ? <div className="pw-history">{[...snapshot.events].reverse().map(event => <article key={event.id}><div className={`pw-history-dot source-${event.source}`}/><div><div className="pw-history-title"><h3>{EVENT_LABELS[event.kind] ?? event.kind}</h3><span>{event.source === 'app' ? 'Work App' : event.source === 'agent' ? '小屿' : event.source === 'timer' ? '系统' : '其他来源'}</span></div><p>{event.aggregateId.slice(0, 8)} · {event.kind}</p><time dateTime={event.at}>{formatDate(event.at)} {formatTime(event.at)}</time></div></article>)}</div> : <Empty icon="history" title="还没有历史事件" text="当你创建任务、安排日程或与小屿对话后，变化会记录在这里。"/>}</div>}
        </>}
        <div className="pw-chat-inline"><ChatPanel snapshot={snapshot} draft={draft} setDraft={setDraft} busy={isChatBusy} onSend={sendChat} onCancel={cancelConversation}/></div>
      </main>
      <aside className="pw-chat-rail"><ChatPanel snapshot={snapshot} draft={draft} setDraft={setDraft} busy={isChatBusy} onSend={sendChat} onCancel={cancelConversation}/></aside>
    </div>
    <button className="pw-chat-fab" onClick={() => setChatOpen(true)} aria-label="打开与小屿的对话"><Icon name="chat" size={20}/><span>问问小屿</span>{snapshot?.counts.pending ? <i>{snapshot.counts.pending}</i> : null}</button>
    {chatOpen && <div className="pw-chat-drawer-layer" onMouseDown={event => { if (event.target === event.currentTarget) setChatOpen(false); }}><div className="pw-chat-drawer" role="dialog" aria-modal="true" aria-label="小屿对话抽屉"><ChatPanel mobile snapshot={snapshot} draft={draft} setDraft={setDraft} busy={isChatBusy} onClose={() => setChatOpen(false)} onSend={sendChat} onCancel={cancelConversation}/></div></div>}
    {editor?.kind === 'task' && <TaskForm key={editor.item?.id ?? 'new'} item={editor.item} busy={isBusy} onClose={closeEditor} onSubmit={submitEditor}/>}
    {editor?.kind === 'schedule' && <ScheduleForm key={editor.item?.id ?? 'new'} item={editor.item} tasks={snapshot?.tasks ?? []} busy={isBusy} onClose={closeEditor} onSubmit={submitEditor}/>}
    {cancelSchedule && <Modal title="取消这项日程？" eyebrow="独立控制操作" onClose={() => setCancelSchedule(null)}><div className="pw-confirm"><p>将取消「{cancelSchedule.title}」。取消不会撤销已经完成的其他工作，也不会回滚关联任务。</p><div className="pw-form-actions"><button className="pw-button pw-button-quiet" onClick={() => setCancelSchedule(null)}>保留日程</button><button className="pw-button pw-button-danger" disabled={isBusy} onClick={() => { const schedule = cancelSchedule; void execute({ kind: 'schedule.update', id: schedule.id, expectedRevision: schedule.revision, input: { state: 'cancelled' }, commandId: commandId(), actorId: OWNER_ID, source: 'app' }, '日程已取消').then(ok => { if (ok) setCancelSchedule(null); }); }}>确认取消</button></div></div></Modal>}
    {toast && <div className={`pw-toast pw-toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}><span>{toast.tone === 'success' ? <Icon name="check" size={17}/> : toast.tone === 'info' ? <Icon name="clock" size={17}/> : <Icon name="close" size={17}/>}</span><p>{toast.text}</p><button onClick={() => setToast(null)} aria-label="关闭提示"><Icon name="close" size={15}/></button></div>}
  </div>;
}

export const inject = ['slots', 'remote'];

export async function apply(ctx: import('@deepseek-ai/cordis').Context) {
  await ctx.remote.$mount(LIFE_REMOTE);
  const life = (ctx.remote as unknown as { life: LifeClient }).life;
  if (!life) throw new Error('Life Remote did not provide the life namespace.');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'personal-work' }, () => <WorkApp life={life}/>));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'personal-work', order: 5, label: 'Work' }, ({ size = 18 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 15.5c2-1.2 3-1.2 5 0s3 1.2 5 0 3-1.2 6 0M4 19c2-1.2 3-1.2 5 0s3 1.2 5 0 3-1.2 6 0"/><path d="m8 12 4-8 4 8H8Z"/><path d="M12 4v8"/></svg>));
}

