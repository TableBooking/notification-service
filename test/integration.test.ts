process.env.LOG_LEVEL = 'silent';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const temp = await mkdtemp(join(tmpdir(), 'tablebooking-test-'));
const keyPath = join(temp, 'public.pem');
await writeFile(keyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
process.env.DATABASE_URL = 'postgresql://localhost/test';
process.env.RABBITMQ_URL = 'amqp://localhost';
process.env.JWT_PUBLIC_KEY_PATH = keyPath;
process.env.DB_SSL_ENABLED = 'false';
process.env.CONSUMER_ENABLED = 'false';
process.env.DELIVERY_WORKER_ENABLED = 'false';
const { Database } = await import('../src/infrastructure/database/database.service.js');
const { DomainConsumer, DomainController } =
  await import('../src/modules/notification/notification.js');
import type { PinoLogger } from 'nestjs-pino';
import { createServer } from 'node:net';
const { parseEvent } = await import('../src/infrastructure/messaging/state-event.js');
const customer = '11111111-1111-4111-8111-111111111111';
const booking = '44444444-4444-4444-8444-444444444444';
const principal = { user: { sub: customer, role: 'CUSTOMER' as const } };
function event(version: number, state: string) {
  return parseEvent({
    eventId: randomUUID(),
    eventType: 'booking.state-changed.v1',
    schemaVersion: 1,
    aggregateId: booking,
    aggregateVersion: version,
    occurredAt: '2026-12-01T10:00:00Z',
    producer: 'operations-service',
    correlationId: randomUUID(),
    data: {
      customerId: customer,
      email: 'guest@example.test',
      slotId: '2026-12-02-dinner',
      partySize: 4,
      state,
      previousState: version === 1 ? null : 'REQUESTED',
      actorId: 'system',
    },
  });
}
test('notification database integration', async (t) => {
  const pg = new PGlite();
  await pg.exec('CREATE SCHEMA notification');
  await pg.exec(
    await readFile('migrations/001_init.sql', 'utf8').then((s) =>
      s.replace('SET LOCAL search_path TO notification', 'SET search_path TO notification'),
    ),
  );
  const db = new Database();
  const query = async (sql: string, params?: unknown[]) => {
    const result = await pg.query(sql, params);
    return {
      ...result,
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rows.length || result.affectedRows || 0,
    };
  };
  Object.defineProperty(db, 'pool', {
    value: { query, connect: async () => ({ query, release() {} }), end: async () => {} },
  });
  const consumer = new DomainConsumer(db, { warn: () => {} } as unknown as PinoLogger);
  const api = new DomainController(db);
  try {
    await t.test('persist once, ownership, preference snapshots and mark-read', async () => {
      const first = event(1, 'REQUESTED');
      await consumer.handle(first);
      await consumer.handle(first);
      let list = await api.mine(principal, {});
      assert.equal(list.data.length, 1);
      assert.equal(list.unreadCount, 1);
      const id = list.data[0]!.id;
      await assert.rejects(api.read(id, { user: { sub: randomUUID(), role: 'CUSTOMER' } }));
      const read = await api.read(id, principal);
      assert.equal((await api.read(id, principal)).readAt, read.readAt);
      assert.equal((await api.unread(principal)).unreadCount, 0);
      await api.updatePreferences(principal, { emailEnabled: false, inAppEnabled: false });
      await consumer.handle(event(2, 'CONFIRMED'));
      list = await api.mine(principal, {});
      assert.equal(list.data.length, 1);
      assert.deepEqual(await api.preferences(principal), {
        emailEnabled: false,
        inAppEnabled: false,
      });
      await assert.rejects(
        api.updatePreferences(principal, { emailEnabled: 'false', inAppEnabled: true }),
      );
    });
    await t.test('stale email is skipped before any SMTP connection', async () => {
      await api.updatePreferences(principal, { emailEnabled: true, inAppEnabled: true });
      await consumer.handle(event(3, 'CANCELLED'));
      await consumer.deliver();
      const result = await query(
        'SELECT delivery_status,skip_reason FROM notification.notification_jobs WHERE aggregate_version=1',
      );
      assert.equal((result.rows[0] as { delivery_status: string }).delivery_status, 'SKIPPED');
      assert.equal((result.rows[0] as { skip_reason: string }).skip_reason, 'STALE_EVENT');
      await api.readAll(principal);
      assert.equal((await api.unread(principal)).unreadCount, 0);
    });
    await t.test(
      'SMTP failure retries, success persists attempt, expired lease recovers',
      async () => {
        const { config } = await import('../src/config/env.js');
        let reject = true;
        const server = createServer((socket) => {
          socket.setEncoding('utf8');
          socket.write('220 localhost test SMTP\r\n');
          let buffer = '';
          let data = false;
          socket.on('data', (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\r\n')) >= 0) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (data) {
                if (line === '.') {
                  data = false;
                  socket.write('250 queued\r\n');
                }
                continue;
              }
              if (line.startsWith('EHLO') || line.startsWith('HELO'))
                socket.write('250 localhost\r\n');
              else if (line.startsWith('MAIL'))
                socket.write(reject ? '451 temporary failure\r\n' : '250 OK\r\n');
              else if (line.startsWith('RCPT')) socket.write('250 OK\r\n');
              else if (line === 'DATA') {
                data = true;
                socket.write('354 send data\r\n');
              } else if (line === 'QUIT') socket.end('221 bye\r\n');
              else socket.write('250 OK\r\n');
            }
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing SMTP address');
        config.SMTP_HOST = '127.0.0.1';
        config.SMTP_PORT = address.port;
        config.SMTP_REQUIRE_TLS = 'false';
        config.SMTP_SECURE = 'false';
        try {
          await query("UPDATE notification.notification_jobs SET delivery_status='SKIPPED'");
          const ev = { ...event(1, 'REQUESTED'), aggregateId: randomUUID() };
          await consumer.handle(ev);
          await consumer.deliver();
          let result = await query(
            'SELECT * FROM notification.notification_jobs WHERE event_id=$1',
            [ev.eventId],
          );
          assert.equal((result.rows[0] as { delivery_status: string }).delivery_status, 'RETRY');
          await query(
            'UPDATE notification.notification_jobs SET next_attempt_at=now() WHERE event_id=$1',
            [ev.eventId],
          );
          reject = false;
          await consumer.deliver();
          result = await query(
            'SELECT delivery_status,attempts FROM notification.notification_jobs WHERE event_id=$1',
            [ev.eventId],
          );
          assert.equal((result.rows[0] as { delivery_status: string }).delivery_status, 'SENT');
          assert.equal((result.rows[0] as { attempts: number }).attempts, 2);
          await query(
            "UPDATE notification.notification_jobs SET delivery_status='SENDING',locked_until=now()-interval '1 second',lock_token=$2 WHERE event_id=$1",
            [ev.eventId, randomUUID()],
          );
          await consumer.deliver();
          result = await query(
            'SELECT attempts FROM notification.notification_jobs WHERE event_id=$1',
            [ev.eventId],
          );
          assert.equal((result.rows[0] as { attempts: number }).attempts, 3);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          );
        }
      },
    );
    if (process.env.RUN_BROKER_TESTS === 'true')
      await t.test('real broker duplicate delivery, bounded retry and isolated DLQ', async () => {
        const url = process.env.BROKER_TEST_URL;
        if (!url) throw new Error('BROKER_TEST_URL required; use a development broker');
        const { config } = await import('../src/config/env.js');
        const { createApplication } = await import('../src/bootstrap.js');
        const { Messaging } = await import('../src/infrastructure/messaging/messaging.service.js');
        const amqp = (await import('amqplib')).default;
        const prefix = 'tablebooking.test.' + randomUUID();
        config.RABBITMQ_URL = url;
        config.MQ_EVENTS_EXCHANGE = prefix + '.events';
        config.MQ_RETRY_EXCHANGE = prefix + '.retry';
        config.MQ_DLX = prefix + '.dlx';
        config.MQ_QUEUE = prefix + '.queue';
        config.MQ_DLQ = prefix + '.dlq';
        config.MQ_RETRY_DELAYS_MS = [20, 30, 50];
        config.MQ_MAX_RETRIES = 3;
        const app = await createApplication();
        const applicationDb = app.get(Database);
        await applicationDb.pool.end();
        Object.defineProperty(applicationDb, 'pool', { value: db.pool });
        const messaging = app.get(Messaging);
        const connection = await amqp.connect(url);
        const ch = await connection.createConfirmChannel();
        const wait = async (check: () => Promise<boolean>) => {
          const deadline = Date.now() + 15000;
          while (!(await check())) {
            if (Date.now() > deadline) throw new Error('Broker integration timeout');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        };
        try {
          config.CONSUMER_ENABLED = 'true';
          messaging.onModuleInit();
          await wait(async () => messaging.connected);
          const ev = { ...event(1, 'REQUESTED'), aggregateId: randomUUID() };
          for (let i = 0; i < 2; i++)
            ch.publish(
              config.MQ_EVENTS_EXCHANGE,
              config.MQ_ROUTING_KEY,
              Buffer.from(JSON.stringify(ev)),
              { persistent: true },
            );
          await ch.waitForConfirms();
          await wait(
            async () =>
              Number(
                (
                  await query(
                    'SELECT count(*) AS count FROM notification.notification_jobs WHERE event_id=$1',
                    [ev.eventId],
                  )
                ).rows[0]?.count,
              ) === 1,
          );
          ch.publish(config.MQ_EVENTS_EXCHANGE, config.MQ_ROUTING_KEY, Buffer.from('{bad json'), {
            persistent: true,
          });
          await ch.waitForConfirms();
          await wait(async () => {
            const message = await ch.get(config.MQ_DLQ, { noAck: false });
            if (!message) return false;
            assert.equal(message.content.toString(), '{bad json');
            assert.equal(message.properties.headers?.['x-retry-count'], 4);
            ch.ack(message);
            return true;
          });
        } finally {
          config.CONSUMER_ENABLED = 'false';
          await app.close();
          for (const queue of [
            config.MQ_QUEUE,
            config.MQ_DLQ,
            ...[20, 30, 50].map((delay) => config.MQ_QUEUE + '.retry.' + delay),
          ])
            await ch.deleteQueue(queue);
          for (const exchange of [
            config.MQ_EVENTS_EXCHANGE,
            config.MQ_RETRY_EXCHANGE,
            config.MQ_DLX,
          ])
            await ch.deleteExchange(exchange);
          await ch.close();
          await connection.close();
        }
      });
    await t.test('HTTP authentication, validation and gateway contract', async () => {
      const { createApplication } = await import('../src/bootstrap.js');
      const app = await createApplication();
      const applicationDb = app.get(Database);
      await applicationDb.pool.end();
      Object.defineProperty(applicationDb, 'pool', { value: db.pool });
      await app.listen(0, '127.0.0.1');
      const target = await app.getUrl();
      let gateway: { close: () => Promise<void> } | undefined;
      const sign = (sub = customer, audience = 'restaurant-api') =>
        new SignJWT({ sub, role: 'CUSTOMER' })
          .setProtectedHeader({ alg: 'RS256' })
          .setIssuer('restaurant-auth')
          .setAudience(audience)
          .setExpirationTime('5m')
          .sign(keys.privateKey);
      try {
        let base = target;
        if (process.env.RUN_GATEWAY_TESTS === 'true') {
          const module = await import(
            pathToFileURL(resolve('../Api-gateway/dist/bootstrap.js')).href
          );
          const gw = await module.createApplication({
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            JWT_PUBLIC_KEY_PATH: keyPath,
            TRACKING_SERVICE_URL: target,
            NOTIFICATION_SERVICE_URL: target,
            RATE_LIMIT_MAX: '1000',
          });
          await gw.listen(0, '127.0.0.1');
          base = await gw.getUrl();
          gateway = gw;
        }
        const token = await sign();
        const headers = { authorization: 'Bearer ' + token };
        const path = '/api/notifications/mine';
        assert.equal((await fetch(base + path)).status, 401);
        assert.equal(
          (
            await fetch(base + path, {
              headers: { authorization: 'Bearer ' + (await sign(customer, 'wrong')) },
            })
          ).status,
          401,
        );
        const response = await fetch(base + path, { headers });
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('x-request-id'));
        const listing = (await response.json()) as { data: { id: string }[] };
        assert.ok(Array.isArray(listing.data));
        assert.equal(
          (await fetch(base + '/api/notifications/unread-count', { headers })).status,
          200,
        );
        assert.equal(
          (await fetch(base + '/api/notifications/read-all', { method: 'POST', headers })).status,
          200,
        );
        assert.equal(
          (
            await fetch(base + '/api/notifications/' + listing.data[0]!.id + '/read', {
              method: 'POST',
              headers,
            })
          ).status,
          200,
        );
        assert.equal(
          (await fetch(base + '/api/notifications/preferences', { headers })).status,
          200,
        );
        assert.equal(
          (
            await fetch(base + '/api/notifications/preferences', {
              method: 'PATCH',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({ emailEnabled: true, inAppEnabled: true }),
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(base + '/api/notifications/preferences', {
              method: 'PATCH',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({ emailEnabled: 'false', inAppEnabled: true }),
            })
          ).status,
          400,
        );
      } finally {
        await gateway?.close();
        await app.close();
      }
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
    await consumer.onModuleDestroy();
    await pg.close();
  }
});
