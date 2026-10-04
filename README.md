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

Phase 4A adds migration `024_auth_identities.sql` for Google and Apple provider
subject mappings. Apply it before deploying code that uses the identity repository.
Phase 4A did not expose sign-in or linking routes.
The repository supports one Google and one Apple identity per user; a provider
subject belongs to only one user. Existing password accounts are not backfilled.

Provider ID-token verification is disabled by default. Set
`GOOGLE_AUTH_ENABLED=true` with comma-separated exact `GOOGLE_CLIENT_IDS`, or
`APPLE_AUTH_ENABLED=true` with exact `APPLE_CLIENT_IDS`, to enable the respective
verifier. The backend does not derive these IDs from bundle identifiers. Both
verifiers check RS256 signatures using the providers' HTTPS JWKS endpoints, with
a five-second fetch timeout, a 30-second key-refresh cooldown, and a ten-minute
key cache. An unavailable provider/configuration returns
`AUTH_PROVIDER_UNAVAILABLE`; invalid tokens return `AUTH_INVALID_PROVIDER_TOKEN`.
These modules never log identity tokens. Phase 4A needs no Apple private key,
Team ID, or Key ID because it does not exchange authorization codes.

Apple verification requires an `expectedNonce` equal to the exact signed
`nonce` claim. If the eventual client sends a SHA-256 nonce to Apple, the caller
must pass that hashed value to the verifier. This phase does not issue, store,
or consume nonce challenges; that binding belongs to the later sign-in flow.
Google and Apple `sub` values are identity keys. Provider email is metadata and
must not be used to auto-link a ChainBell account; Google's `email_verified`
alone does not establish current ownership of every third-party email address.
Apple email can be omitted or be a private relay address, and the first-login
name is not a signed ID-token claim.

Phase 4B adds `POST /api/v1/auth/google` with JSON body `{"idToken":"..."}`.
It verifies the Google ID token before accessing the database. A known Google
subject signs in to its mapped user without updating the account email or its
verification state. A new subject with an unused usable email creates a user
with no password or name, a Google identity, and an auth session in one
transaction. `X-Auth-Refresh: true` adds `data.refreshToken` to the standard
`data.user` and `data.accessToken` response, as on password sign-in. The
Google route has a separate per-IP limit, `AUTH_GOOGLE_RATE_LIMIT_MAX` (default
30 per `AUTH_RATE_LIMIT_WINDOW_MS`).

Only a signed `email_verified` claim together with a `gmail.com` address, or
a signed `email_verified` claim and an `hd` value equal to the email domain,
marks a newly created ChainBell account verified. Other Google emails start
unverified and remain subject to the existing email-code gate. Email never
identifies an existing Google account. If an unknown Google subject supplies
an email already used by ChainBell, the route returns `409 AUTH_LINK_REQUIRED`
without creating a session or linking accounts. An unknown subject without a
usable email returns `422 AUTH_EMAIL_REQUIRED`. Invalid provider tokens return
`401 AUTH_INVALID_PROVIDER_TOKEN`; disabled or misconfigured verification
returns `503 AUTH_PROVIDER_UNAVAILABLE`. Provider management is described in
Phase 4D below.

Phase 4C adds `POST /api/v1/auth/apple` with JSON body
`{"identityToken":"...","expectedNonce":"..."}`. The expected nonce is
required and must equal the nonce claim in Apple's signed identity token. If
the client sends Apple a SHA-256 hash of a raw nonce, it must send that exact
hash as `expectedNonce` to this backend. A missing nonce is a request validation
error; a mismatched nonce is `401 AUTH_INVALID_PROVIDER_TOKEN`. Because the
expected value comes from the client and is not bound to a server-issued
challenge, this comparison alone is not one-time replay protection. This phase
does not persist nonce challenges or exchange Apple authorization codes.

A known Apple subject signs in to its existing ChainBell user even when Apple
omits email, and never changes the stored email or verification state. A new
subject with an unused usable email creates a passwordless user, Apple
identity, and session atomically; `X-Auth-Refresh: true` adds the usual rotating
refresh credential. A signed `email_verified` true claim marks that new
ChainBell email verified, including an Apple private relay address. A false or
absent claim leaves it behind the normal email-code gate. The signed subject,
not email or relay address, is the identity key. Existing email collisions
return `409 AUTH_LINK_REQUIRED`; unknown subjects without usable email return
`422 AUTH_EMAIL_REQUIRED`. Apple sign-in has its own per-IP limit,
`AUTH_APPLE_RATE_LIMIT_MAX` (default 30 per auth rate-limit window). Profile
name is left null; provider management is described in Phase 4D below.

Phase 4D adds explicit provider management for verified, session-backed
accounts. `POST /api/v1/auth/identities/link` takes a Bearer access token and
one of these JSON bodies:

```json
{"provider":"google","idToken":"...","currentPassword":"..."}
{"provider":"apple","identityToken":"...","expectedNonce":"...","currentPassword":"..."}
```

The current password is checked before the provider token. The user row and
current session are then locked and rechecked before the identity is inserted.
The provider's signed `sub` is the identity key; provider email never chooses,
merges, or changes a ChainBell account. Repeating a link of the same identity
returns `200 {"data":{"provider":"google|apple","linked":true}}`. A provider
already on the account returns `409 AUTH_IDENTITY_ALREADY_LINKED`; a subject
owned by another account returns `409 AUTH_IDENTITY_LINKED_ELSEWHERE` without
account details.

`DELETE /api/v1/auth/identities/:provider` takes a Bearer token and JSON body
`{"currentPassword":"..."}`. It returns
`200 {"data":{"provider":"google|apple","unlinked":true}}`. It removes only
the current user's identity. A provider cannot be removed if it is the last
usable login method (`409 AUTH_LAST_LOGIN_METHOD`). Missing or incorrect
current passwords yield `AUTH_REAUTH_REQUIRED` or `AUTH_REAUTH_FAILED`. For
social-only users, fresh provider reauthentication is deferred: adding a
provider returns `AUTH_REAUTH_METHOD_UNAVAILABLE`, and removing one of several
providers also returns that error. No identity change is authorized by the
Bearer token alone. The existing session and refresh credential stay valid
after a successful change; no JWT claims change. Both endpoints share a
per-IP limit of `AUTH_IDENTITY_MANAGEMENT_RATE_LIMIT_MAX` (default 20 per auth
rate-limit window). Existing email verification rules still apply.

### Permanent account deletion

Apply migrations `026_account_deletion_reauth.sql` and
`027_google_deletion_oauth.sql` before enabling deletion.
`POST /api/v1/auth/account/reauth/challenge` and
`POST /api/v1/auth/account/reauth/verify` issue a five-minute, session-bound
deletion authorization after current password proof or a server-nonce-bound
Apple identity token. Google deletion reauthentication uses a separate,
backend-owned OAuth authorization-code flow. Configure
`GOOGLE_DELETION_OAUTH_CLIENT_ID`, `GOOGLE_DELETION_OAUTH_CLIENT_SECRET`, and
`GOOGLE_DELETION_OAUTH_REDIRECT_URI` for one Google web OAuth client. Register
the exact HTTPS redirect URI in Google Cloud Console; its path must be
`/api/v1/auth/account/reauth/google/callback`. Missing configuration makes
Google deletion proof unavailable. This is separate from `GOOGLE_CLIENT_IDS`
and ordinary Google sign-in.

For Google, the challenge response contains `challengeId`, `method`,
`expiresAt`, and `authorizationUrl`. Open that URL in the system browser.
Google returns to the public backend callback, which records verified proof
without returning a deletion authorization or authenticating the browser.
The app then calls the authenticated verify endpoint with only
`{"challengeId":"...","method":"google"}` to receive the usual short-lived
deletion authorization. The callback shows a generic HTML result, so the app
should wait for browser completion before calling verify. The server stores
only SHA-256 digests of the OAuth state and raw Google nonce. It temporarily
stores the PKCE verifier because only the backend exchanges the code; it is
cleared after a terminal callback. Codes and Google tokens are never stored.

`DELETE /api/v1/auth/account` requires a session-backed Bearer access token
and JSON body `{"deletionAuthorization":"<opaque authorization>"}`. It accepts
email-unverified users and returns `200 {"data":{"deleted":true}}` after
the database commits. It rejects legacy sessionless tokens and invalid,
expired, or already-used authorizations. The endpoint accepts no password or
provider token. Deletion consumes the authorization and deletes the user in
one transaction; foreign keys cascade through sessions, identities, wallets,
devices, caches, and notifications. The transaction marks each affected
Alchemy chain/address pair dirty. The reconciliation worker later checks
whether another user still tracks the pair before changing the provider watch.
Process-local holdings and positions caches may hold inaccessible stale
entries until their TTL expires; they cannot authorize a deleted account or
restore its database rows. A push already handed to FCM cannot be recalled.

### Email verification and password recovery

Phase 2 adds 6-digit, 10-minute email challenges. Migration 020 marked existing email accounts verified; migration 021 preserves access for older accounts without an email, which cannot receive a verification code. Accounts registered afterward start with `user.emailVerified: false`. Registration does not send a code automatically: the client calls the verification request endpoint when its code-entry screen is ready. An unverified token can access `/auth/me`, `/auth/logout`, and the verification request/verify routes, but normal protected application routes return `403 AUTH_EMAIL_VERIFICATION_REQUIRED`. After verification, the same token works on protected routes because each request loads current user state from PostgreSQL.

Phase 3A keeps the login/register response shape (`data.user` and `data.accessToken`) and the configured access-token lifetime, which defaults to seven days. Newly issued access JWTs contain a `sid` for a PostgreSQL `auth_sessions` row. Every authenticated request checks that the session belongs to the user and has not been revoked. `POST /auth/logout` takes the Bearer access token and returns `200 {"data":{"message":"Logged out."}}`; for a session-backed token it revokes only that session. Successful password reset revokes all of the account's sessions in the same transaction as the password change and challenge consumption.

Phase 3B adds optional opaque refresh credentials. Apply `023_auth_session_refresh_tokens.sql` before deploying this version. Login or registration with `X-Auth-Refresh: true` adds `data.refreshToken` to the existing `data.user` and `data.accessToken` response. Calls without that header keep the exact Phase 3A response. The refresh token is a 32-byte random value encoded as URL-safe base64; PostgreSQL stores only its SHA-256 digest. Its default lifetime is 30 days, configurable with `JWT_REFRESH_TOKEN_TTL_SECONDS`; each successful refresh starts a new 30-day lifetime. Access-token lifetime is unchanged. Sessions created before Phase 3B and sessions created without the header keep working with their access token but have no refresh credential.

`POST /auth/refresh` accepts `{"refreshToken":"..."}` without a Bearer token and returns `200 {"data":{"user":{...},"accessToken":"...","refreshToken":"..."}}`. It rotates the refresh token in the same session under a database row lock; the previous token immediately stops working. Invalid, expired, replayed, or revoked credentials return `401 AUTH_INVALID_REFRESH_TOKEN` without account or session details. Unverified users may refresh, but their new access token remains subject to mandatory email verification on protected routes. Logout and password reset revoke the session and therefore its refresh credential. Refresh requests have a separate per-IP limit, `AUTH_REFRESH_RATE_LIMIT_MAX` (default 120 per `AUTH_RATE_LIMIT_WINDOW_MS`, default 15 minutes).

Signed access JWTs without `sid` are accepted temporarily for existing clients only when they have a valid `iat` and have not been invalidated by `app_users.legacy_access_revoked_at`. Logout with a legacy JWT revokes legacy access for that user. The comparison rejects tokens issued in the same JWT-second as the cutoff as well as older tokens. Keep legacy support for at least the previous maximum access-token lifetime after the last session-less token issuer is gone; remove it only in a later deployment.

All endpoints are under `/api/v1`. JSON responses use the existing `data` or `error` envelope:

| Endpoint | Body and auth | Success |
| --- | --- | --- |
| `POST /auth/email-verification/request` | Bearer access token; empty body | `202 {"data":{"message":"If verification is needed, a code has been sent."}}` |
| `POST /auth/email-verification/verify` | Bearer access token; `{"code":"123456"}` | `200 {"data":{"user":{... ,"emailVerified":true}}}` |
| `POST /auth/forgot-password` | `{"email":"name@example.com"}` | `202 {"data":{"message":"If an account exists for that email, a reset code has been sent."}}` for known and unknown accounts |
| `POST /auth/reset-password` | `{"email":"name@example.com","code":"123456","newPassword":"at-least-8-chars"}` | `200 {"data":{"message":"Password updated."}}` |
| `POST /auth/logout` | Bearer access token; empty body | `200 {"data":{"message":"Logged out."}}` |
| `POST /auth/refresh` | `{"refreshToken":"..."}`; no Bearer token | `200 {"data":{"user":{...},"accessToken":"...","refreshToken":"..."}}` |

Invalid, expired, exhausted, or reused codes return `400 AUTH_INVALID_CODE`. Verification requests require the account's bearer token; a rapid resend returns `429 AUTH_CODE_REQUEST_LIMITED`. Code requests and submissions also use the existing per-IP auth rate-limit window. Each account may issue at most five challenges per purpose per hour, with a one-minute spacing while an active code exists; each code allows five wrong guesses. Issuing a new code consumes the older active code. Codes are generated with cryptographic randomness and stored as keyed digests, never plaintext. Successful reset changes the scrypt password hash and revokes previously issued access tokens.

Forgot-password returns the same response even if delivery fails. Delivery failures are logged with safe error codes and the undelivered challenge is consumed; monitor those logs. A 300 ms response floor reduces obvious timing differences, though email network latency can still vary. Verification requests return `503 AUTH_EMAIL_UNAVAILABLE` if delivery fails. Neither response includes the code or provider details.

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

Wallet create, update, and delete commit chain/address reconciliation markers with the wallet change.
The background worker reads current PostgreSQL desired state, checks the corresponding Alchemy webhook,
and adds or removes an address only when needed. Provider failure does not change the wallet API response;
the marker is retried with backoff. The worker starts with the API process and does not block HTTP startup.

Use the full drift sweep to enqueue differences caused outside wallet mutations:

```bash
npm run reconcile:alchemy-webhook-addresses -- --dry-run
npm run reconcile:alchemy-webhook-addresses
```

The drift sweep:

- Reads current watched addresses
- Queues missing database addresses and stale provider addresses for the same worker
- Handles Ethereum and Base independently
- Stops a chain sweep if provider pagination is incomplete or fails

The full drift sweep is manual in this phase; periodic worker polling processes queued markers.

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

### Transactional email

```env
AUTH_EMAIL_DELIVERY_MODE=resend
RESEND_API_KEY=<server-side secret>
AUTH_EMAIL_FROM=ChainBell <no-reply@your-verified-domain.example>
```

Production startup requires Resend mode, an API key, and a sender address. Verify the sender domain with Resend, grant the API key email-send permission, and store the key in deployment secrets. The [Resend email API](https://resend.com/docs/api-reference/emails/send-email) is called through a small service adapter with a 10-second deadline. Development defaults to `AUTH_EMAIL_DELIVERY_MODE=disabled`; requests cannot deliver codes until configured. Automated tests never contact Resend and inject a stub delivery service. Do not log or commit API keys, challenge codes, or email payloads.

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

Production defaults to verified database TLS. For Railway's private
`*.railway.internal` database URL when its CA is unavailable to the backend,
set `DATABASE_SSL_MODE=railway-private`. This keeps PostgreSQL TLS enabled but
does not verify the database certificate; it relies on Railway's encrypted,
environment-isolated private network. The mode rejects other hosts and URL
SSL parameters. Use `verify-full` with a trusted CA when one is available.

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
