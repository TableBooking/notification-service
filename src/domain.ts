import {
  Controller,
  Get,
  Post,
  HttpCode,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { PinoLogger } from 'nestjs-pino';
import { Database } from './database.js';
import { config } from './config.js';
import { AccessGuard, type Principal } from './auth.js';
import type { StateEvent } from './event.js';
export function emailState(state: string) {
  return ['REQUESTED', 'CONFIRMED', 'REJECTED', 'CANCELLED'].includes(state);
}
export function notification(row: {
  id: string;
  event_id: string;
  booking_id: string;
  type: string;
  title: string;
  message: string;
  created_at: Date;
  delivery_status: string;
  read_at: Date | null;
}) {
  return {
    id: row.id,
    eventId: row.event_id,
    bookingId: row.booking_id,
    type: row.type,
    title: row.title,
    message: row.message,
    createdAt: row.created_at.toISOString(),
    deliveryStatus: row.delivery_status,
    ...(row.read_at ? { readAt: row.read_at.toISOString() } : {}),
  };
}
@Injectable()
export class DomainConsumer implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private active?: Promise<void>;
  constructor(
    private readonly db: Database,
    private readonly log: PinoLogger,
  ) {}
  async handle(ev: StateEvent) {
    await this.db.tx(async (c) => {
      const fresh = await c.query(
        'INSERT INTO notification.inbox_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id',
        [ev.eventId],
      );
      if (!fresh.rowCount) return;
      const pref = await c.query(
        'SELECT * FROM notification.notification_preferences WHERE customer_id=$1',
        [ev.data.customerId],
      );
      const email = pref.rows[0]?.email_enabled ?? true;
      const inApp = pref.rows[0]?.in_app_enabled ?? true;
      await c.query(
        'INSERT INTO notification.booking_event_cursors(booking_id,latest_version) VALUES($1,$2) ON CONFLICT(booking_id) DO UPDATE SET latest_version=GREATEST(booking_event_cursors.latest_version,excluded.latest_version),updated_at=now()',
        [ev.aggregateId, ev.aggregateVersion],
      );
      const enabled = email && emailState(ev.data.state);
      const title = 'Đặt bàn: ' + ev.data.state;
      const message =
        'Đặt bàn ' +
        ev.aggregateId +
        '; ca ' +
        ev.data.slotId +
        '; số khách ' +
        ev.data.partySize +
        (ev.data.tableId ? '; bàn ' + ev.data.tableId : '') +
        (ev.data.reason ? '; lý do ' + ev.data.reason : '');
      await c.query(
        'INSERT INTO notification.notification_jobs(id,event_id,booking_id,customer_id,recipient_email,type,title,message,aggregate_version,email_enabled,in_app_enabled,delivery_status,skip_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          randomUUID(),
          ev.eventId,
          ev.aggregateId,
          ev.data.customerId,
          ev.data.email,
          'BOOKING_' + ev.data.state,
          title,
          message,
          ev.aggregateVersion,
          email,
          inApp,
          enabled ? 'PENDING' : 'SKIPPED',
          enabled ? null : email ? 'STATE_POLICY' : 'EMAIL_DISABLED',
        ],
      );
    });
  }
  onModuleInit() {
    if (config.DELIVERY_WORKER_ENABLED === 'true') this.loop();
  }
  private loop() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.deliver()
        .catch(() => this.log.warn('Delivery worker iteration failed'))
        .finally(() => this.loop());
    }, config.DELIVERY_POLL_INTERVAL_MS);
  }
  async deliver() {
    const token = randomUUID();
    const job = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM notification.notification_jobs WHERE ((delivery_status IN ('PENDING','RETRY') AND next_attempt_at<=now()) OR (delivery_status='SENDING' AND locked_until<now())) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      const j = rows[0];
      if (!j) return;
      await c.query(
        "UPDATE notification.notification_jobs SET delivery_status='SENDING',lock_token=$2,locked_until=now()+$3*interval '1 millisecond' WHERE id=$1",
        [j.id, token, config.DELIVERY_LEASE_MS],
      );
      return j;
    });
    if (!job) return;
    const latest = await this.db.pool.query(
      'SELECT latest_version FROM notification.booking_event_cursors WHERE booking_id=$1',
      [job.booking_id],
    );
    if (latest.rows[0]?.latest_version > job.aggregate_version) {
      await this.db.pool.query(
        "UPDATE notification.notification_jobs SET delivery_status='SKIPPED',skip_reason='STALE_EVENT',locked_until=NULL,lock_token=NULL WHERE id=$1 AND lock_token=$2",
        [job.id, token],
      );
      return;
    }
    const attempt = job.attempts + 1;
    let success = false;
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE === 'true',
      requireTLS: config.SMTP_REQUIRE_TLS === 'true',
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      ...(config.SMTP_USER
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } }
        : {}),
    });
    try {
      await transport.sendMail({
        from: config.SMTP_FROM,
        to: job.recipient_email,
        subject: job.title,
        text: job.message,
        messageId: '<' + job.id + '@tablebooking.local>',
      });
      success = true;
    } catch {
      this.log.warn({ jobId: job.id, attempt }, 'SMTP delivery failed');
    } finally {
      transport.close();
    }
    await this.db.tx(async (c) => {
      const lock = await c.query(
        'SELECT id FROM notification.notification_jobs WHERE id=$1 AND lock_token=$2 FOR UPDATE',
        [job.id, token],
      );
      if (!lock.rowCount) return;
      await c.query(
        'INSERT INTO notification.notification_delivery_attempts(job_id,attempt_number,success,error_message) VALUES($1,$2,$3,$4)',
        [job.id, attempt, success, success ? null : 'SMTP delivery failed'],
      );
      const delay = [30, 120, 600, 1800][Math.min(attempt - 1, 3)] ?? 1800;
      await c.query(
        "UPDATE notification.notification_jobs SET delivery_status=$3,attempts=$4,next_attempt_at=now()+$5*interval '1 second',sent_at=CASE WHEN $6 THEN now() ELSE sent_at END,last_error=$7,locked_until=NULL,lock_token=NULL WHERE id=$1 AND lock_token=$2",
        [
          job.id,
          token,
          success ? 'SENT' : attempt >= config.DELIVERY_MAX_ATTEMPTS ? 'FAILED' : 'RETRY',
          attempt,
          delay,
          success,
          success ? null : 'SMTP delivery failed',
        ],
      );
    });
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
}
@Controller('api/notifications')
@UseGuards(AccessGuard)
export class DomainController {
  constructor(private readonly db: Database) {}
  @Get('mine') async mine(@Req() req: { user: Principal }, @Query() raw: unknown) {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        unreadOnly: z.enum(['true', 'false']).default('false'),
      })
      .strict()
      .parse(raw);
    const filter = 'customer_id=$1 AND in_app_enabled AND ($2=false OR read_at IS NULL)';
    const params = [req.user.sub, q.unreadOnly === 'true'];
    const { rows } = await this.db.pool.query(
      'SELECT * FROM notification.notification_jobs WHERE ' +
        filter +
        ' ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',
      [...params, q.limit, (q.page - 1) * q.limit],
    );
    const count = await this.db.pool.query(
      'SELECT count(*) FROM notification.notification_jobs WHERE ' + filter,
      params,
    );
    const total = Number(count.rows[0].count);
    return {
      data: rows.map(notification),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
      ...(await this.unread(req)),
    };
  }
  @Get('unread-count') async unread(@Req() req: { user: Principal }) {
    const { rows } = await this.db.pool.query(
      'SELECT count(*) FROM notification.notification_jobs WHERE customer_id=$1 AND in_app_enabled AND read_at IS NULL',
      [req.user.sub],
    );
    return { unreadCount: Number(rows[0].count) };
  }
  @Post('read-all') @HttpCode(200) async readAll(@Req() req: { user: Principal }) {
    await this.db.pool.query(
      'UPDATE notification.notification_jobs SET read_at=now() WHERE customer_id=$1 AND in_app_enabled AND read_at IS NULL',
      [req.user.sub],
    );
    return { ok: true };
  }
  @Post(':id/read') @HttpCode(200) async read(
    @Param('id') id: string,
    @Req() req: { user: Principal },
  ) {
    z.uuid().parse(id);
    const { rows } = await this.db.pool.query(
      'UPDATE notification.notification_jobs SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND customer_id=$2 AND in_app_enabled RETURNING *',
      [id, req.user.sub],
    );
    if (!rows[0]) throw new NotFoundException();
    return notification(rows[0]);
  }
  @Get('preferences') async preferences(@Req() req: { user: Principal }) {
    const { rows } = await this.db.pool.query(
      'SELECT * FROM notification.notification_preferences WHERE customer_id=$1',
      [req.user.sub],
    );
    return {
      emailEnabled: rows[0]?.email_enabled ?? true,
      inAppEnabled: rows[0]?.in_app_enabled ?? true,
    };
  }
  @Patch('preferences') async updatePreferences(
    @Req() req: { user: Principal },
    @Body() body: unknown,
  ) {
    const dto = z
      .object({ emailEnabled: z.boolean(), inAppEnabled: z.boolean() })
      .strict()
      .parse(body);
    await this.db.pool.query(
      'INSERT INTO notification.notification_preferences(customer_id,email_enabled,in_app_enabled) VALUES($1,$2,$3) ON CONFLICT(customer_id) DO UPDATE SET email_enabled=$2,in_app_enabled=$3,updated_at=now()',
      [req.user.sub, dto.emailEnabled, dto.inAppEnabled],
    );
    return dto;
  }
}
