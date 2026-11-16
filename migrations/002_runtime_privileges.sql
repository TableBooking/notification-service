-- Runtime may inspect migration state but cannot change it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notification_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON notification.schema_migrations FROM notification_app;
    GRANT SELECT ON notification.schema_migrations TO notification_app;
  END IF;
END $$;
