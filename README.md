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
5. A notification worker resolves active `device_tokens` for the wallet owner and sends Firebase Cloud Messaging pushes.
6. Delivery results are recorded in `notification_deliveries` for retries, auditability, and debugging.

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

Returns normalized wallet events sorted by newest first.

### Alchemy webhook

`POST /webhooks/alchemy`

Accepts Alchemy Address Activity webhook payloads and stores matching wallet activity in `wallet_events`.
This endpoint remains the primary real-time notification ingestion path.

### Health check

`GET /health`

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
