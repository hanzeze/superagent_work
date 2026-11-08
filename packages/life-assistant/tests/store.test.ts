import test from 'node:test';
import assert from 'node:assert/strict';
import { LifeStore } from '../src/server/store.ts';
import type { Command } from '../src/contract.ts';
import { randomUUID } from 'node:crypto';
const task = (commandId = randomUUID()): Command => ({ kind:'task.create', commandId, actorId:'personal-owner', source:'test', expectedRevision:0, input:{ title:'整理本周计划', status:'active', nextStep:'列出三件重要的事', milestones:[{text:'周一复盘',done:true}] } });
test('persists, rebuilds a shared projection and replays commands', () => {
  const path = `/tmp/life-store-${randomUUID()}.db`;
  let store = new LifeStore(path); const command = task('same-id');
  const first = store.execute(command); assert.equal(first.snapshot.tasks[0].title,'整理本周计划');
  assert.deepEqual(store.execute(command),first); assert.equal(store.snapshot().events.length,1);
  assert.throws(() => store.execute({...task('same-id'),input:{title:'different'}}),/different command/);
  store.close();
  store = new LifeStore(path); assert.equal(store.snapshot().tasks.length,1); assert.equal(store.snapshot().revision,1); store.close();
});
test('rejects stale human and agent writes without overwriting', () => {
  const store = new LifeStore(':memory:'); const created = store.execute(task()); const id = created.id;
  const command: Command = { kind:'task.update', id, commandId:randomUUID(), actorId:'personal-owner',source:'test',expectedRevision:2,input:{title:'错误覆盖'} };
  assert.throws(() => store.execute(command), /expected revision 2, current 1/);
  assert.equal(store.snapshot().tasks[0].title,'整理本周计划');
  store.execute({...command,commandId:randomUUID(),actorId:'agent',source:'agent',expectedRevision:1,input:{status:'done'}});
  assert.equal(store.snapshot().tasks[0].status,'done'); assert.equal(store.snapshot().tasks[0].revision,2); store.close();
});
test('durable accepted conversation has independent cancellation and outbox recovery', () => {
  const store = new LifeStore(':memory:');
  const accepted = store.execute({ kind:'conversation.create',commandId:'message-1',actorId:'personal-owner',source:'app',expectedRevision:0,content:'帮我安排明天的复盘' });
  assert.equal(accepted.snapshot.conversations[0].status,'accepted'); assert.equal(store.readyOutbox().length,1);
  const outboxId = String(store.readyOutbox()[0].id);
  assert.equal(store.claimOutbox(outboxId),true); assert.equal(store.claimOutbox(outboxId),false);
  store.failOutbox(outboxId,'transient'); assert.equal(store.readyOutbox().length,0);
  store.execute({ kind:'conversation.control',id:accepted.id,commandId:'cancel-1',actorId:'personal-owner',source:'app',expectedRevision:1,action:'cancel' });
  assert.equal(store.snapshot().conversations[0].status,'cancelled'); store.close();
});
test('validates time zones, links and foreign owner commands', () => {
  const store = new LifeStore(':memory:');
  assert.throws(() => store.execute({kind:'schedule.create',commandId:'bad',actorId:'intruder',source:'app',expectedRevision:0,input:{title:'bad',startAt:new Date().toISOString(),timeZone:'Asia/Shanghai'}}),/Only the personal owner/);
  assert.throws(() => store.execute({kind:'schedule.create',commandId:'bad-zone',actorId:'personal-owner',source:'test',expectedRevision:0,input:{title:'bad',startAt:new Date().toISOString(),timeZone:'Mars/Olympus'}}),/Unknown IANA/);
  const taskId = store.execute(task()).id;
  const schedule = store.execute({kind:'schedule.create',commandId:'schedule-1',actorId:'personal-owner',source:'test',expectedRevision:0,input:{title:'复盘',startAt:'2026-11-10T09:00:00+08:00',timeZone:'Asia/Shanghai',taskId}});
  assert.equal(schedule.snapshot.schedules[0].startAt,'2026-11-10T01:00:00.000Z'); store.close();
});
