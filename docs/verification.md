# Verification

Local verification completed on 2026-11-16:

- `npm run check`: TypeScript, ESLint and Prettier pass.
- `npm test`: configuration, event contract/hash and unroutable publisher-confirm tests pass.
- `npm run test:gateway`: real Nest gateway and Notification HTTP application, ephemeral RSA keys and embedded PostgreSQL pass. Covers all six endpoints, ownership, strict preferences, read idempotency and snapshots.
- SMTP fixture: transient failure creates RETRY, subsequent delivery creates SENT, expired lease is recovered, stale email is skipped before SMTP.
- `npm run build`: pass.
- Compose configuration validated with `--no-env-resolution`.

Not executed: Docker build/run (daemon unavailable), real RabbitMQ retry/outage, Supabase bootstrap/grants/SSL, delivery through a real SMTP provider and cloud deployment. `npm run test:broker` requires a development broker. SMTP delivery remains at-least-once; an email already being sent cannot be recalled.
