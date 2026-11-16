import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
process.env.DATABASE_URL='postgresql://localhost/test';process.env.RABBITMQ_URL='amqp://localhost';process.env.JWT_PUBLIC_KEY_PATH='test';process.env.DB_SSL_ENABLED='false';process.env.CONSUMER_ENABLED='false';process.env.DELIVERY_WORKER_ENABLED='false';
const {Database}=await import('../src/database.js');
const {DomainConsumer,DomainController}=await import('../src/domain.js');
const {PinoLogger}=await import('nestjs-pino');
const {parseEvent}=await import('../src/event.js');
const customer='11111111-1111-4111-8111-111111111111';const booking='44444444-4444-4444-8444-444444444444';
const principal={user:{sub:customer,role:'CUSTOMER' as const}};
function event(version:number,state:string){return parseEvent({eventId:randomUUID(),eventType:'booking.state-changed.v1',schemaVersion:1,aggregateId:booking,aggregateVersion:version,occurredAt:'2026-12-01T10:00:00Z',producer:'operations-service',correlationId:randomUUID(),data:{customerId:customer,email:'guest@example.test',slotId:'2026-12-02-dinner',partySize:4,state,previousState:version===1?null:'REQUESTED',actorId:'system'}});}
test('notification database integration',async t=>{
 const pg=new PGlite();await pg.exec('CREATE SCHEMA notification');await pg.exec(await readFile('migrations/001_init.sql','utf8').then(s=>s.replace('SET LOCAL search_path TO notification','SET search_path TO notification')));
 const db=new Database();const query=async(sql:string,params?:unknown[])=>{const result=await pg.query(sql,params);return {...result,rowCount:result.affectedRows??result.rows.length};};Object.defineProperty(db,'pool',{value:{query,connect:async()=>({query,release(){}}),end:async()=>{}}});
 const consumer=new DomainConsumer(db,new PinoLogger({}));const api=new DomainController(db);
 try{
await t.test('persist once, ownership, preference snapshots and mark-read',async()=>{const first=event(1,'REQUESTED');await consumer.handle(first);await consumer.handle(first);let list=await api.mine(principal,{});assert.equal(list.data.length,1);assert.equal(list.unreadCount,1);const id=list.data[0]!.id;await assert.rejects(api.read(id,{user:{sub:randomUUID(),role:'CUSTOMER'}}));const read=await api.read(id,principal);assert.equal((await api.read(id,principal)).readAt,read.readAt);assert.equal((await api.unread(principal)).unreadCount,0);await api.updatePreferences(principal,{emailEnabled:false,inAppEnabled:false});await consumer.handle(event(2,'CONFIRMED'));list=await api.mine(principal,{});assert.equal(list.data.length,1);assert.deepEqual(await api.preferences(principal),{emailEnabled:false,inAppEnabled:false});await assert.rejects(api.updatePreferences(principal,{emailEnabled:'false',inAppEnabled:true}));});
await t.test('stale email is skipped before any SMTP connection',async()=>{await api.updatePreferences(principal,{emailEnabled:true,inAppEnabled:true});await consumer.handle(event(3,'CANCELLED'));await consumer.deliver();const result=await query('SELECT delivery_status,skip_reason FROM notification.notification_jobs WHERE aggregate_version=1');assert.equal((result.rows[0] as {delivery_status:string}).delivery_status,'SKIPPED');assert.equal((result.rows[0] as {skip_reason:string}).skip_reason,'STALE_EVENT');await api.readAll(principal);assert.equal((await api.unread(principal)).unreadCount,0);});
}finally{await consumer.onModuleDestroy();await pg.close();}
});
