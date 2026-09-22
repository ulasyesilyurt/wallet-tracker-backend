# Wallet Tracker Backend

Node.js + Express backend for a React Native wallet tracking app. This backend now includes wallet management APIs, a webhook-first ingestion path for Alchemy address activity, and an Ethereum polling tracker kept as an optional fallback/debug tool.

## Architecture

The backend is split into small layers so blockchain ingestion and push delivery can be added without rewriting the API surface:

- `src/config`: environment parsing and structured logging
- `src/db`: PostgreSQL pool, query helper, and SQL migrations
- `src/modules/wallets`: request validation, controllers, service logic, and repository queries
- `src/modules/ethereum`: Ethereum polling tracker, log normalization, and metadata lookup
- `src/modules/events`: shared wallet event persistence and query APIs
- `src/modules/webhooks`: webhook payload validation and Alchemy event ingestion
- `src/middlewares`: shared request validation and centralized error handling
- `src/routes`: API route registration

### Real-time notification architecture

1. The mobile app registers user devices and tracked wallets through the API.
2. Alchemy webhooks deliver address activity to the backend as the primary production ingestion path for real-time notifications.
3. The webhook layer validates the payload, normalizes native/token/NFT transfers, and stores them in `wallet_events`.
4. The Ethereum tracker can still poll confirmed blocks as an optional fallback/debug path when needed.
5. A notification worker creates one durable `notifications` row per alert-worthy wallet event, even when the owner has no active device tokens.
6. The worker sends Firebase Cloud Messaging pushes to active devices and records each attempt in `notification_deliveries` for audit and debugging. Read state belongs to the logical notification.

The outbox retries transient FCM failures up to three attempts with backoff. Each retry skips devices whose delivery row is already `delivered` and devices with a terminal failure. Firebase-confirmed invalid registration tokens are deactivated for their owning user. An outbox job is `sent` once no active device needs another attempt; exhausted transient failures leave the job `failed` while the logical alert remains in history. Push delivery is at least once: if FCM accepts a message but the process stops before PostgreSQL records `delivered`, the next attempt may send that device a duplicate.

### Recommended operating mode

- Primary real-time mode:
  - use `POST /api/v1/webhooks/alchemy`
  - keep `ENABLE_ETHEREUM_TRACKER=false`
  - this is the recommended production setup
- Polling tracker mode:
  - set `ENABLE_ETHEREUM_TRACKER=true`
  - use it only for local tracker tests, fallback recovery, or debugging specific historical ranges
  - it is not the preferred primary path when the tracker is far behind because block scanning and RPC rate limits can make catch-up slow

This structure keeps API logic, chain-specific ingestion, and later notification workers separated so more chains can be added as parallel modules instead of being mixed into route handlers.

## Database schema

The schema is defined in [`src/db/migrations/001_initial_schema.sql`](/Users/ulas/Documents/New%20project/src/db/migrations/001_initial_schema.sql).
The tracking-specific additions are in [`src/db/migrations/002_wallet_event_tracking.sql`](/Users/ulas/Documents/New%20project/src/db/migrations/002_wallet_event_tracking.sql) and [`src/db/migrations/003_native_eth_transfer_support.sql`](/Users/ulas/Documents/New%20project/src/db/migrations/003_native_eth_transfer_support.sql).

Core tables:

- `app_users`: application users
- `device_tokens`: FCM tokens per user/device
- `tracked_wallets`: wallet addresses a user wants to monitor
- `wallet_track_preferences`: per-wallet event subscriptions such as token transfers or NFT sales
- `wallet_events`: normalized blockchain events ready for display and notification
- `notifications`: one logical alert per wallet event, including read state
- `notification_deliveries`: FCM delivery attempts and status
- `chain_sync_state`: persisted block cursor so the Ethereum tracker can resume safely after restarts

The schema uses enums for wallet tracking types and delivery states, unique constraints to prevent duplicate tracking rows, and indexes for the most common lookups.

## API endpoints

Base URL: `/api/v1`

### Add wallet

`POST /users/:userId/wallets`

```json
{
  "chainId": "ethereum-mainnet",
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "label": "Whale wallet",
  "trackTypes": ["token_transfer", "nft_buy", "nft_sell"]
}
```

### List wallets

`GET /users/:userId/wallets`

### Delete wallet

`DELETE /users/:userId/wallets/:walletId`

### Register device token

`POST /users/:userId/device-tokens`

```json
{
  "token": "your-device-fcm-token",
  "platform": "ios"
}
```

### Delete device token

`DELETE /users/:userId/device-tokens`

```json
{
  "token": "your-device-fcm-token"
}
```

### Wallet events

`GET /wallets/:walletId/events`

Returns normalized wallet events sorted by `occurredAt`, `createdAt`, then event ID,
all newest first. The response keeps `data` as an array for existing mobile clients.
It now also includes a top-level `pagination` object with `limit`, `offset`, and
`hasMore`. `limit` defaults to 50, may be 1–100, and `offset` defaults to 0;
invalid values return `400`. For example, request
`/wallets/:walletId/events?limit=50&offset=50` for the second page. The existing
`groupTransactions=true` option remains available and groups complete transactions
within the selected page. Events from a transaction split across pages remain
individual event items so the API does not present an incomplete purchase or sale
as a complete transaction. A mobile load-more flow is needed to display older pages.

### Alchemy webhook

`POST /webhooks/alchemy`

Accepts Alchemy Address Activity webhook payloads and stores matching wallet activity in `wallet_events`.
Signed deliveries must include a configured Ethereum or Base `webhookId`, its matching
network, and the `X-Alchemy-Signature` generated with that webhook's signing secret.
This endpoint remains the primary real-time notification ingestion path.

### Recover Alchemy wallet subscriptions

Wallet create, update, and delete save the database change before synchronizing Alchemy.
If synchronization fails, the API returns `503` with `ALCHEMY_WEBHOOK_SYNC_FAILED` in
the existing error envelope. The wallet change was saved; run reconciliation instead
of assuming the operation was rolled back.

With `ALCHEMY_NOTIFY_API_KEY` and both chain-specific webhook IDs configured, preview
and then repair Ethereum and Base subscriptions:

```bash
npm run reconcile:alchemy-webhook-addresses -- --dry-run
npm run reconcile:alchemy-webhook-addresses
```

The live command reads every page of each webhook's watched-address list, adds missing
database addresses, and removes stale addresses only after checking that no active
wallet still uses that address on the same chain. Logs report planned and completed
counts per chain. A failed or incomplete address-list response stops changes for that
chain and exits nonzero. Repeating the command is safe. Legacy watched-address
overrides apply only to Ethereum dry-runs; live reconciliation always reads Alchemy.

### Health check

- `GET /api/v1/health` is liveness: the HTTP process responds with `status: ok`.
- `GET /api/v1/ready` is readiness: it returns `status: ok` only while PostgreSQL responds and the notification outbox worker has started. Otherwise it returns HTTP 503 with `status: not_ready`.

Configure the deployment host to use `/api/v1/ready` for traffic gating and `/api/v1/health` for process liveness. The server checks PostgreSQL before opening its HTTP listener and exits nonzero if the startup check fails; the host should restart it. The portfolio snapshot job is not a readiness dependency.

### Internal operational diagnostics

Set `OPERATIONS_DIAGNOSTICS_TOKEN` to a random value of at least 32 characters to
enable `GET /api/v1/operations/status`. Leave it empty to disable the endpoint;
disabled requests return `404`. The endpoint requires the value in the
`X-Operations-Token` header. It does not use ordinary wallet-user JWTs, because
the application has no administrator role and system-wide queue counts must not
be available to regular users.

```bash
curl -H 'X-Operations-Token: replace_with_your_operations_token' \
  https://backend.example.test/api/v1/operations/status
```

The response contains aggregate process uptime, PostgreSQL availability,
notification worker heartbeat timestamps, outbox counts, oldest pending-job age,
stale processing count, webhook and Alchemy sync success/failure counters, and
portfolio snapshot run state. It contains no wallet addresses, payloads, provider
URLs, credentials, or stack traces. Keep this endpoint restricted to an internal
network or monitoring probe and store the token in the deployment secret store.
The token header is redacted from HTTP logs.

During the internal test release, monitor these signals and structured log events:

- alert immediately when `/api/v1/ready` returns `503` repeatedly or database
  readiness failures repeat;
- alert on a process restart loop, using the `process_start` event and process
  `startedAt`/`uptimeSeconds` diagnostics;
- alert when `notificationOutbox.failedCount` is above zero;
- alert when `oldestPendingAgeSeconds` exceeds 600 seconds or
  `staleProcessingCount` is above zero;
- alert when the worker has started but `lastCycleCompletedAt` stops advancing for
  more than two polling intervals;
- investigate repeated `webhook.failureCount` increases, `Alchemy webhook rejected`
  bursts, or Alchemy wallet sync/reconciliation failure logs;
- investigate a portfolio snapshot `lastRunFailedAt` newer than
  `lastRunSucceededAt`, while keeping snapshots outside readiness.

These checks require only HTTP probing and structured log collection. No external
monitoring vendor is required.

## Proxy, rate limits, and CORS

By default `TRUST_PROXY_HOPS=0` and `TRUST_PROXY_CIDRS` is empty: Express uses
the socket address as the client IP and ignores client-supplied
`X-Forwarded-For`. For one reverse proxy, configure both settings with that
proxy's source address or narrow CIDR, for example:

```env
TRUST_PROXY_HOPS=1
TRUST_PROXY_CIDRS=10.0.0.5/32
```

The proxy must replace or append `X-Forwarded-For` with the actual client IP,
and its connection to the backend must come from the configured address.
Express trusts at most the configured number of hops and only listed proxy
addresses. Keep the backend reachable only through the proxy; a direct client
using the proxy's allowed source address cannot be distinguished by IP alone.
Invalid or incomplete proxy settings fail startup. If the deployment has more
than one proxy, list only the expected proxy CIDRs and set the actual hop count
(1 through 5).

The login, registration, and global API limits use Express's resolved client IP.
The existing limits and response shape are unchanged. Their in-memory store is
process-local, so these limits are suitable for **one backend instance only**;
multiple instances would each have an independent counter. The global API
limit still excludes health, readiness, and Alchemy webhook requests.

Development CORS allows local browser and React Native tooling. In production,
`CORS_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS browser origins
(scheme, hostname, and optional port, without a trailing slash), for example:

```env
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

An empty production list allows no browser origins, which is appropriate while
the first-party client is native mobile only. Requests without an `Origin` header,
including native React Native, server-to-server, and Alchemy webhook requests,
still pass. Disallowed browser origins receive HTTP 403. Allowed preflight
requests support the existing HTTP methods and requested headers, including
`Authorization` and `Content-Type`. Authentication uses bearer tokens rather
than browser cookies, so CORS credentials are not enabled. CORS is a browser
access rule; it does not authenticate API or webhook requests.

## Provider request budgets

`PROVIDER_REQUEST_TIMEOUT_MS` defaults to 5000 ms per Alchemy RPC, Alchemy
pricing, Zerion positions, and CoinGecko fallback request. HTTP requests use an
abort signal; ethers RPC transports also have a request deadline. The existing
Alchemy Notify management calls retain their separate
`ALCHEMY_NOTIFY_REQUEST_TIMEOUT_MS` default of 10000 ms. The Firebase Admin SDK
uses its own 15000 ms messaging request timeout.

`ZERION_MAX_PAGES=10` bounds one wallet/chain positions fetch to ten pages of
100 requested positions (at most 1000 positions and 2000 included records kept).
`ALCHEMY_TOKEN_BALANCE_MAX_PAGES=5` bounds one wallet/chain balance fetch to
five pages of 100 requested balances (at most 500 kept). When either limit is
reached, positions or holdings are marked partial and report a page-limit reason;
they must not be interpreted as complete portfolio values. Page-limited holdings
do not replace the last known good or persisted holdings snapshot. Alchemy webhook
watched-address reconciliation has a fixed 100-page, 10000-address limit and
fails that chain's reconciliation before applying its changes when the limit is
exceeded.

Existing metadata and price caches, in-flight request reuse, 429 cooldowns,
stale positions/holdings fallbacks, and the eight-second per-chain holdings
response timeout remain in place. Tune page limits only after measuring normal
wallet sizes and provider usage; each extra page can trigger metadata and pricing
requests. Provider errors are logged by provider, operation, safe code/status,
and timeout classification without API keys or credential-bearing URLs.

## Production database

Use a PostgreSQL service with automated backups and a verified TLS endpoint. Store
`DATABASE_URL` in the deployment secret store; do not put it in logs or source control.
The backend uses one pool per process. Its default maximum is 10 connections, so
reserve capacity for migrations, administration, and any additional instances.

Local development uses the `.env.example` URL and disables TLS by default. In
`NODE_ENV=production`, the backend defaults to TLS with certificate and hostname
verification. Configure either:

```env
DATABASE_URL=postgresql://app_user:replace_me@db.example.com:5432/wallet_tracker
DATABASE_SSL_MODE=verify-full
DATABASE_SSL_CA_FILE=/mounted-secrets/postgres-ca.pem
```

or a URL with `sslmode=verify-full` and, when the provider supplies a private CA,
`sslrootcert=/mounted-secrets/postgres-ca.pem`. The CA file must exist in the
container at startup. With no custom CA, the operating system's trusted CAs are
used. Use the provider's DNS hostname that appears in its certificate. Do not
combine URL TLS parameters with `DATABASE_SSL_MODE` or `DATABASE_SSL_CA_FILE`.
Production rejects disabled or unverified TLS settings. No cloud vendor is assumed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | `10` | Maximum connections per process |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Maximum wait to establish or obtain a connection |
| `DATABASE_IDLE_TIMEOUT_MS` | `30000` | Close idle pooled connections |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | PostgreSQL server limit for ordinary statements |
| `DATABASE_MIGRATION_LOCK_WAIT_TIMEOUT_MS` | `10000` | Maximum advisory lock wait |
| `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` | `5000` | Maximum wait for table/row locks during migration SQL |
| `DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS` | `300000` | PostgreSQL server limit for each migration statement |

All timeout values are positive milliseconds. Migrations run in transactions and
retain their advisory lock. A lock or statement timeout exits the migration command
with failure; resolve the cause before retrying. Run migrations once as a deployment
step before allowing traffic. Readiness still uses a three second `SELECT 1` probe
and returns HTTP 503 when PostgreSQL is unavailable. Shutdown closes the pool.

### Backup and restore readiness

Minimum production requirements: enable automated daily backups and continuous WAL
archiving or provider point-in-time recovery; retain recoverable history for at least
14 days; encrypt backups at rest and in transit; restrict backup and restore access;
monitor backup failures and storage capacity; and keep a backup copy independent of
the application instance. Set an operational target of at most one hour of data loss
and four hours to restore service. Confirm the database provider's actual recovery
granularity and retention meet those targets before launch.

At least quarterly, and after a database or backup configuration change, test a
restore into an isolated PostgreSQL instance at a chosen recovery timestamp:

1. Record backup timestamp, recovery target, source version, and restore start time.
2. Restore using the provider's documented procedure. Keep the restored instance
   isolated from production webhooks, workers, and notification delivery.
3. Run `npm run migrate` against the restored database with the matching application
   release, then check that the command exits successfully.
4. Verify expected tables and migration records, recent `wallet_events`,
   `notifications`, `notification_outbox`, and `chain_sync_state` rows; compare row
   counts and latest timestamps with the source at the recovery point.
5. Start the API with external delivery disabled, check `/api/v1/ready`, and perform
   a read-only authenticated query. Record elapsed restore time and data gap; confirm
   both meet the recovery targets. Delete the isolated copy securely afterward.

For a portable manual snapshot, `pg_dump --format=custom --file=backup.dump` and
`pg_restore --no-owner --dbname=wallet_tracker_restore backup.dump` use the standard
`PGHOST`, `PGUSER`, `PGDATABASE`, and password-file connection settings. Run restore
only against a fresh isolated database. A manual dump is supplemental and does not
replace automated backups or point-in-time recovery.

## Local setup

1. Copy `.env.example` to `.env`
2. Install dependencies:

```bash
npm install
```

3. Run migrations:

```bash
npm run migrate
```

4. Start the API:

```bash
npm run dev
```

## Continuous integration

The repository includes a minimal GitHub Actions workflow at
[`/.github/workflows/backend-ci.yml`](/Users/ulas/Documents/New%20project/.github/workflows/backend-ci.yml).

It runs on `push` and `pull_request` and will:

- install dependencies with `npm ci`
- start a temporary PostgreSQL service
- run `npm run migrate`
- run optional `lint`, `typecheck`, or `check` scripts if they exist
- run `npm test`

### CI environment used for tests

The current backend tests require a PostgreSQL database plus a JWT secret. The workflow provides:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wallet_tracker_test
JWT_SECRET=dev_jwt_secret_that_is_long_enough_for_local_checks
NODE_ENV=test
ENABLE_PUSH_NOTIFICATIONS=false
ENABLE_ETHEREUM_TRACKER=false
ENABLE_PORTFOLIO_SNAPSHOT_JOB=false
```

No real provider API keys are required for the current test suite.

### Webhook-first config guidance

For normal real-time notification mode, keep the polling tracker disabled:

```env
ENABLE_ETHEREUM_TRACKER=false
```

Only enable the polling tracker for local polling tests or fallback/debug sessions:

```env
ENABLE_ETHEREUM_TRACKER=true
```

### Test push notifications locally

1. Install the new Firebase dependency:

```bash
npm install
```

2. Configure push settings in `.env`:

```env
ENABLE_PUSH_NOTIFICATIONS=true
FIREBASE_DRY_RUN=true
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
```

`FIREBASE_DRY_RUN=true` lets you verify the backend notification pipeline without actually delivering to a device.

3. Register a device token for the user whose wallets are being tracked:

```bash
curl -X POST http://localhost:3000/api/v1/users/YOUR_USER_ID/device-tokens \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_FCM_DEVICE_TOKEN",
    "platform": "ios"
  }'
```

4. Trigger a new wallet event using the Alchemy webhook endpoint or a real webhook delivery.

5. Check Postgres:

```sql
SELECT
  nd.wallet_event_id,
  nd.device_token_id,
  nd.status,
  nd.retryable,
  nd.provider_message_id,
  nd.error_message,
  nd.sent_at
FROM notification_deliveries nd
ORDER BY nd.created_at DESC
LIMIT 20;
```

With dry-run enabled, you should still see delivery rows being written, which confirms the notification pipeline is executing.

6. To test real push delivery on a phone:
- set `FIREBASE_DRY_RUN=false`
- use a real FCM token from your React Native app
- trigger another wallet event
- confirm the push appears on the device

### Test the Alchemy webhook locally

For this unsigned local example only, set `ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV=true` with
`NODE_ENV=development`. Production requires separate Ethereum and Base webhook IDs and
signing secrets and will reject the unsigned setting. Real Alchemy deliveries must use
the configured webhook ID and that webhook's `X-Alchemy-Signature`.

1. Start the API:

```bash
npm run dev
```

2. Make sure you have at least one tracked wallet in the database for the address you want Alchemy to report.

3. Send a test payload to the local webhook endpoint:

```bash
curl -X POST http://localhost:3000/api/v1/webhooks/alchemy \
  -H "Content-Type: application/json" \
  -d '{
    "webhookId": "wh_test_123",
    "id": "evt_test_123",
    "createdAt": "2026-03-23T12:00:00.000Z",
    "type": "ADDRESS_ACTIVITY",
    "event": {
      "network": "ETH_MAINNET",
      "activity": [
        {
          "blockNum": "0x1792f90",
          "hash": "0xeaffdf76f405b79e366e9ac15630ab80456563eb0fe332a1546f56e84c9ec735",
          "fromAddress": "0x1bcae4fbdccb2ad253521a3ff00313317775d1eb",
          "toAddress": "0xb4c00dcc9080f0ceaff5660498995120baf5958c",
          "category": "token",
          "asset": "WETH",
          "rawContract": {
            "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "decimals": 18,
            "rawValue": "100000000000000"
          },
          "log": {
            "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "logIndex": "0x228",
            "topics": [
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
            ],
            "data": "0x00000000000000000000000000000000000000000000000000005af3107a4000"
          }
        }
      ]
    }
  }'
```

4. You should get a `202` response showing how many activities were received, normalized, and inserted.

5. Verify the stored event:

```bash
curl http://localhost:3000/api/v1/wallets/YOUR_WALLET_ID/events
```

You can also inspect Postgres directly:

```sql
SELECT
  wallet_id,
  transaction_hash,
  event_type,
  asset_symbol,
  amount,
  from_address,
  to_address,
  occurred_at
FROM wallet_events
ORDER BY occurred_at DESC
LIMIT 20;
```

### Run the Ethereum tracker

Set these values in `.env` first:

```env
ENABLE_ETHEREUM_TRACKER=true
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
ETHEREUM_CONFIRMATIONS=6
ETHEREUM_BATCH_SIZE=250
ETHEREUM_POLL_INTERVAL_MS=15000
ETHEREUM_START_BLOCK=0
ETHEREUM_RPC_REQUEST_DELAY_MS=1000
ETHEREUM_RPC_MAX_RETRIES=5
ETHEREUM_RPC_BACKOFF_BASE_MS=1000
```

Then either:

- run it inside the API process with `ENABLE_ETHEREUM_TRACKER=true npm run dev`
- or run it separately with:

```bash
npm run tracker:ethereum
```

## Notes

- `userId` is currently passed as a route parameter to keep the first iteration simple. In production, this should come from authenticated user context.
- Address validation currently targets EVM-compatible addresses. If you want to support Solana, Bitcoin, or other chains, add chain-specific validators in `wallets.schemas.js`.
- The webhook path is now the intended production ingestion path. The polling tracker remains available for fallback/debug workflows.
- Firebase push delivery is triggered after a new `wallet_events` row is successfully inserted.
- The current tracker detects native ETH transfers plus ERC-20 and ERC-721 / ERC-1155 NFT transfers on Ethereum mainnet.
- NFT buy/sell classification is not implemented yet because it requires marketplace-specific trade decoding beyond generic transfer logs.
- The tracker now rate-limits RPC usage for Alchemy-style providers by spacing calls, retrying `429` responses with exponential backoff, and keeping the sync cursor unchanged when a batch fails.

## Testing Native ETH Transfers Locally

1. Add a tracked wallet with `"trackTypes": ["native_transfer"]` or include `native_transfer` alongside the other types.
2. Set `ENABLE_ETHEREUM_TRACKER=true` and a valid `ETHEREUM_RPC_URL` in `.env`.
3. For a fast test, set:

```env
ETHEREUM_CONFIRMATIONS=0
ETHEREUM_BATCH_SIZE=25
ETHEREUM_POLL_INTERVAL_MS=5000
ETHEREUM_RPC_REQUEST_DELAY_MS=1000
ETHEREUM_RPC_MAX_RETRIES=5
ETHEREUM_RPC_BACKOFF_BASE_MS=1000
```

4. Start the tracker with `npm run tracker:ethereum` or run the API with tracking enabled.
5. Send a small ETH transfer either:
   - from your tracked wallet to another address
   - or from another wallet to your tracked wallet
6. Query PostgreSQL after the transaction is mined:

```sql
SELECT
  wallet_id,
  event_type,
  transaction_hash,
  block_number,
  from_address,
  to_address,
  amount_wei,
  amount,
  direction,
  occurred_at
FROM wallet_events
WHERE event_type = 'native_transfer'
ORDER BY created_at DESC
LIMIT 10;
```

You should see:
- `event_type = 'native_transfer'`
- `amount_wei` as the raw wei value
- `amount` as the ETH amount string
- `direction = 'incoming'` when the tracked wallet is the recipient
- `direction = 'outgoing'` when the tracked wallet is the sender
