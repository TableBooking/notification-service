SET LOCAL search_path TO notification;
-- TARGET SCHEMA V2: notification_db
CREATE TABLE IF NOT EXISTS notification_jobs (
 id UUID PRIMARY KEY, event_id UUID NOT NULL UNIQUE,
 booking_id UUID NOT NULL, customer_id UUID NOT NULL,
 recipient_email TEXT NOT NULL, type TEXT NOT NULL,
 title TEXT NOT NULL, message TEXT NOT NULL,
 delivery_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK(delivery_status IN ('PENDING','SENDING','SENT','RETRY','FAILED')),
 attempts INT NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 sent_at TIMESTAMPTZ,last_error TEXT,
 read_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_notification_owner ON notification_jobs(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_notification_pending ON notification_jobs(next_attempt_at)
 WHERE delivery_status IN ('PENDING','RETRY');
CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
 id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL REFERENCES notification_jobs(id),
 attempt_number INT NOT NULL, success BOOLEAN NOT NULL,
 error_message TEXT, attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT ux_attempt_number UNIQUE(job_id,attempt_number)
);
CREATE TABLE IF NOT EXISTS notification_preferences (
 customer_id UUID PRIMARY KEY, email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inbox_events (
 event_id UUID PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notification_jobs DROP CONSTRAINT notification_jobs_delivery_status_check;
ALTER TABLE notification_jobs ADD CONSTRAINT notification_jobs_delivery_status_check CHECK(delivery_status IN ('PENDING','SENDING','SENT','RETRY','FAILED','SKIPPED'));
ALTER TABLE notification_jobs ADD COLUMN aggregate_version INT NOT NULL, ADD COLUMN email_enabled BOOLEAN NOT NULL, ADD COLUMN in_app_enabled BOOLEAN NOT NULL, ADD COLUMN locked_until TIMESTAMPTZ, ADD COLUMN lock_token UUID, ADD COLUMN skip_reason TEXT;
CREATE TABLE booking_event_cursors(booking_id UUID PRIMARY KEY,latest_version INT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX ix_unread ON notification_jobs(customer_id) WHERE in_app_enabled AND read_at IS NULL;
CREATE INDEX ix_lease ON notification_jobs(locked_until) WHERE delivery_status='SENDING';

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='notification_app') THEN REVOKE UPDATE ON notification.notification_delivery_attempts FROM notification_app; REVOKE UPDATE ON notification.inbox_events FROM notification_app; END IF; END $$;
