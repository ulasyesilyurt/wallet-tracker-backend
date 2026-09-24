# Wallet Tracker Backend

Backend service for Wallet Tracker, an alert-first crypto wallet monitoring application.

This service provides wallet management, portfolio aggregation, blockchain event ingestion, notification generation, push delivery, caching, operational diagnostics, and release-oriented production safeguards.

The mobile application is maintained in a separate repository.

## Overview

Wallet Tracker Backend is built around a webhook-first architecture.

Alchemy Address Activity webhooks are the primary production ingestion path for real-time wallet events. Incoming activity is normalized and persisted, then eligible events are converted into logical notifications and delivered to registered devices through Firebase Cloud Messaging.

The backend also aggregates wallet balances, token holdings, DeFi positions, transaction history, and portfolio summaries across supported networks.

Current network support:

- Ethereum
- Base

## Tech Stack

- Node.js
- Express
- PostgreSQL
- Firebase Admin SDK
- Alchemy
- Zerion
- CoinGecko fallback pricing
- JWT authentication
- SQL migrations
- Jest / Supertest

## Architecture

Main backend areas:

```txt
src/
  config/                Environment and logging configuration
  db/                    PostgreSQL pool, helpers, and migrations
  middlewares/           Authentication, validation, errors, rate limits
  modules/
    auth/                Authentication
    wallets/             Wallet management
    holdings/            Token and native balance aggregation
    positions/           DeFi / protocol positions
    portfolioSummary/    Combined wallet portfolio summaries
    events/              Wallet event storage and history
    webhooks/            Alchemy webhook ingestion
    notifications/       Notification history and read state
    notificationOutbox/  Durable push delivery queue
    operations/          Internal operational diagnostics
  routes/                API route registration
```

## Real-Time Notification Flow

The production notification path is:

```txt
Blockchain activity
        ↓
Alchemy Address Activity Webhook
        ↓
Webhook signature validation
        ↓
Event normalization
        ↓
wallet_events
        ↓
Logical notification
        ↓
Notification Outbox
        ↓
Firebase Cloud Messaging
        ↓
Android / APNs
```

Key properties:

- Alchemy webhooks are the primary real-time ingestion mechanism.
- Webhook signatures are validated before ingestion.
- Ethereum and Base use separate webhook IDs and signing secrets.
- Notification history exists independently of active FCM tokens.
- Read / unread state belongs to the logical notification.
- FCM transient failures are retried with backoff.
- Invalid registration tokens are automatically deactivated.
- Delivery attempts are stored for diagnostics.

## Recommended Runtime Mode

For normal production operation:

```env
ENABLE_ETHEREUM_TRACKER=false
```

Use:

```txt
POST /api/v1/webhooks/alchemy
```

as the primary real-time ingestion path.

The Ethereum polling tracker remains available only for fallback, debugging, or local recovery workflows.

## API Base Path

```txt
/api/v1
```

## Main API Areas

### Authentication

Authentication is handled through JWT-based application sessions.

### Wallet Management

Typical wallet operations include:

```txt
POST   /api/v1/users/:userId/wallets
GET    /api/v1/users/:userId/wallets
DELETE /api/v1/users/:userId/wallets/:walletId
```

Wallet configuration includes:

- Address
- Label
- Network selection
- Notification preferences

### Device Tokens

Register a device:

```txt
POST /api/v1/users/:userId/device-tokens
```

Remove a device token:

```txt
DELETE /api/v1/users/:userId/device-tokens
```

Supported platforms include Android and iOS.

### Wallet Events

```txt
GET /api/v1/wallets/:walletId/events
```

Wallet history supports pagination.

Example:

```txt
GET /api/v1/wallets/:walletId/events?limit=50&offset=50
```

The response includes pagination metadata such as:

- `limit`
- `offset`
- `hasMore`

### Alchemy Webhook

```txt
POST /api/v1/webhooks/alchemy
```

The endpoint accepts Alchemy Address Activity webhook deliveries for Ethereum and Base.

Production deliveries must include:

- A configured webhook ID
- A matching network
- `X-Alchemy-Signature`
- The correct webhook signing secret

Unsigned production webhook requests are rejected.

## Alchemy Wallet Reconciliation

Wallet database changes are persisted before Alchemy watched-address synchronization.

If Alchemy synchronization fails, the wallet change remains saved and the API reports:

```txt
ALCHEMY_WEBHOOK_SYNC_FAILED
```

Use reconciliation to repair provider state:

```bash
npm run reconcile:alchemy-webhook-addresses -- --dry-run
npm run reconcile:alchemy-webhook-addresses
```

The reconciliation process:

- Reads current watched addresses
- Adds missing database addresses
- Removes stale provider addresses when safe
- Handles Ethereum and Base independently
- Stops a chain reconciliation if provider pagination is incomplete or fails

## Local Development

### Install dependencies

```bash
npm install
```

### Configure environment

Copy:

```bash
cp .env.example .env
```

Then fill in the required local values.

### Run migrations

```bash
npm run migrate
```

### Start the backend

```bash
npm run dev
```

The default local API is expected on:

```txt
http://localhost:3000
```

## Environment Configuration

Important configuration groups include:

### Database

```env
DATABASE_URL=postgresql://...
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=30000
```

### Holdings

```env
PROVIDER_REQUEST_TIMEOUT_MS=5000
HOLDINGS_CHAIN_TIMEOUT_MS=30000
ALCHEMY_TOKEN_BALANCE_MAX_PAGES=5
```

`PROVIDER_REQUEST_TIMEOUT_MS` limits individual provider calls.

`HOLDINGS_CHAIN_TIMEOUT_MS` limits the complete per-chain holdings computation and defaults to 30 seconds.

### Zerion Positions

```env
ZERION_MAX_PAGES=10
```

Positions pagination is bounded to avoid unbounded provider work.

### Alchemy Webhooks

Typical production configuration includes:

```env
ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET=...
ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET=...

ALCHEMY_WEBHOOK_SIGNING_SECRET_ETHEREUM_MAINNET=...
ALCHEMY_WEBHOOK_SIGNING_SECRET_BASE_MAINNET=...
```

Do not commit webhook signing secrets.

### Push Notifications

```env
ENABLE_PUSH_NOTIFICATIONS=true
FIREBASE_DRY_RUN=false
```

Firebase credentials must be supplied through secure deployment configuration.

## Holdings

Holdings aggregation can include:

- Native balances
- ERC-20 balances
- Token metadata
- Token pricing
- Suspicious-token classification
- Low-value token grouping

Provider work is bounded by request deadlines and pagination limits.

When provider limits or timeouts are reached, the response can be marked partial rather than pretending the portfolio is complete.

Last-known-good holdings data may be reused where appropriate.

## Positions

DeFi and protocol positions are fetched from Zerion.

The backend keeps both in-memory and persisted last-known-good positions.

Persisted positions are stored per wallet and chain.

Important behavior:

- Fresh detail requests may call the live provider.
- Wallet-list mode does not trigger live Zerion fetches.
- List mode first uses memory cache.
- If memory is cold, recently persisted positions may be used.
- Persisted positions older than 24 hours are ignored.
- Partial or failed provider results do not overwrite the last known good result.
- Persisted cache entries are matched against the wallet address before reuse.

This keeps wallet-list portfolio totals more stable across backend restarts.

## Database Migrations

Database schema changes are managed through SQL migrations.

Notable recent migrations include:

```txt
017_wallet_events_history_pagination_index.sql
018_wallet_chain_positions_cache.sql
```

Migration `018_wallet_chain_positions_cache.sql` stores recent last-known-good positions for wallet-list consistency after process restarts.

Run all pending migrations with:

```bash
npm run migrate
```

Production deployments should run migrations before opening traffic.

## Notification Delivery

Each eligible wallet event can produce a logical notification.

Notification delivery is separated from notification history.

This means:

- Alerts can exist even when the user has no active device token.
- One logical alert can have multiple device delivery attempts.
- Read state is not tied to a specific device.
- Failed FCM sends do not remove alert history.

Transient FCM failures are retried up to the configured retry limit.

Firebase-confirmed invalid tokens are deactivated.

## Notification Read State

Main notification operations include:

```txt
GET   /api/v1/notifications
GET   /api/v1/notifications/unread-count
PATCH /api/v1/notifications/:notificationId/read
PATCH /api/v1/notifications/read-all
```

Notification responses include fields such as:

- wallet ID
- chain ID
- type
- category
- severity
- title
- body
- read state

## Health Checks

### Liveness

```txt
GET /api/v1/health
```

Confirms that the HTTP process is running.

### Readiness

```txt
GET /api/v1/ready
```

Readiness requires:

- PostgreSQL connectivity
- Notification outbox worker startup

If a dependency is unavailable, readiness returns HTTP `503`.

Production traffic should be gated on `/api/v1/ready`.

## Operational Diagnostics

An internal diagnostics endpoint can be enabled with:

```env
OPERATIONS_DIAGNOSTICS_TOKEN=...
```

Endpoint:

```txt
GET /api/v1/operations/status
```

Header:

```txt
X-Operations-Token: ...
```

The diagnostics endpoint can expose aggregate runtime information such as:

- Process uptime
- PostgreSQL availability
- Notification worker heartbeat
- Outbox queue counts
- Failed notification count
- Oldest pending job age
- Stale processing count
- Webhook success / failure counters
- Alchemy synchronization status
- Portfolio snapshot job state

It intentionally avoids returning wallet addresses, secrets, provider URLs, or payload data.

Keep this endpoint private.

## Proxy and Rate Limiting

Production reverse-proxy handling is explicit.

Relevant configuration includes:

```env
TRUST_PROXY_HOPS=...
TRUST_PROXY_CIDRS=...
```

Do not blindly trust incoming `X-Forwarded-For` headers.

Rate limiting uses Express's resolved client IP.

Current rate-limit storage is process-local, so multi-instance deployments would require a shared rate-limit store.

## CORS

Native mobile clients do not depend on browser CORS.

For browser clients, production origins can be configured with:

```env
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

An empty production list blocks browser origins while still allowing requests without an `Origin` header, including:

- React Native
- Server-to-server requests
- Alchemy webhooks

## Production Database

Use PostgreSQL with:

- Automated backups
- TLS
- Verified server certificates
- Secret-managed credentials
- Restore testing
- Sufficient connection capacity

In production, database TLS verification is required.

Example:

```env
DATABASE_URL=postgresql://app_user:replace_me@db.example.com:5432/wallet_tracker
DATABASE_SSL_MODE=verify-full
DATABASE_SSL_CA_FILE=/mounted-secrets/postgres-ca.pem
```

Do not put database credentials in Git or logs.

## Backup and Restore

Production database recovery should include:

- Automated daily backups
- Point-in-time recovery or WAL archiving
- Encrypted backups
- Restricted restore access
- Regular restore testing
- Independent backup retention

Restores should be tested in an isolated database before production launch.

## Testing

Run the backend test suite with:

```bash
npm test
```

The current suite covers areas including:

- Authentication
- Wallet ownership
- Webhook validation
- Notification behavior
- Provider timeouts
- Holdings behavior
- Positions persistence
- Read / unread notification state
- API error handling

## Continuous Integration

GitHub Actions runs backend checks on pushes and pull requests.

Typical CI steps include:

```bash
npm ci
npm run migrate
npm test
```

The workflow uses a temporary PostgreSQL database.

Current backend CI is expected to pass without real provider API keys.

## Security Notes

The backend includes release-hardening for:

- Sensitive header redaction
- Webhook signature validation
- Production CORS
- Proxy-aware client IP handling
- Rate limiting
- Provider request deadlines
- Database TLS verification
- Migration locking and timeouts
- Logical notification ownership
- Device-token cleanup
- Operational endpoint protection

Secrets must stay outside Git.

Do not log:

- API keys
- Signing secrets
- JWT secrets
- Firebase credentials
- Database credentials
- Device tokens
- Authentication headers

## Current Release Status

Backend release hardening is largely complete.

Completed areas include:

- Secure Alchemy webhook signing for Ethereum and Base
- Wallet subscription reconciliation
- Notification outbox durability
- Logical notification history
- Read / unread notification semantics
- FCM retry and invalid-token cleanup
- Readiness and liveness checks
- PostgreSQL TLS and migration hardening
- Proxy-aware rate limiting
- Production CORS
- Provider request timeouts
- Pagination limits
- Wallet event history pagination
- Operational diagnostics
- Persisted last-known-good wallet positions

Current release work is focused on:

- Production backend deployment
- Remote PostgreSQL deployment
- Production environment variables
- Running migrations in production
- Production Alchemy webhook URLs
- Monitoring and operational validation
- Mobile release integration

## Deployment

The intended production shape is:

```txt
Mobile App
    ↓
HTTPS
    ↓
Node.js / Express Backend
    ↓
PostgreSQL

Alchemy ──webhooks──> Backend
Backend ──FCM──────> Firebase / APNs / Android
```

A managed deployment platform such as Railway or a similar service can host the backend and PostgreSQL.

Before production traffic:

1. Deploy PostgreSQL.
2. Configure database TLS.
3. Configure backend secrets.
4. Run migrations.
5. Deploy the backend.
6. Verify `/api/v1/health`.
7. Verify `/api/v1/ready`.
8. Configure production Alchemy webhook URLs.
9. Run Alchemy address reconciliation.
10. Test a real wallet event.
11. Confirm notification history.
12. Confirm device delivery.
13. Monitor operational diagnostics.

## License

This project is currently private / experimental.

A production or open-source license can be added before public distribution.
