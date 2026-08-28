# Chat Reliability Architecture Design

**Status:** Approved in chat on 2026-08-28

**Repositories:**

- Backend: `chat-microservices` (`main` baseline `0ef2181`)
- Frontend: `chat-microservices-frontend` (`master` baseline `935c573`)

## Purpose

Improve the chat application without a big-bang rewrite. The work prioritizes silent data loss, duplicate durable operations, cryptographic key races, and contract drift before broader structural cleanup.

The target is an incrementally adoptable architecture that is:

- idempotent at public command boundaries;
- ACID within each PostgreSQL service boundary;
- at-least-once across RabbitMQ, with explicit deduplication;
- organized as small application use cases behind ports and adapters;
- operationally honest about health, retries, and partial failure;
- compatible with DRY, SOLID, Clean Architecture, and Tao of Node principles.

## Scope

This design covers:

- frontend package/tooling consistency and generated API contracts;
- message creation, real-time delivery, receipts, and retries;
- notification persistence and email/push delivery;
- RabbitMQ publishing, consumers, RPC replies, reconnection, and health;
- Signal prekey publication, consumption, backup, and concurrent session creation;
- Redis presence correctness;
- incremental extraction of application, domain, and infrastructure boundaries.

## Non-goals

- Replacing PostgreSQL, RabbitMQ, Redis, Socket.IO, TypeORM, SvelteKit, or Signal protocol libraries.
- Converting all existing code to a new folder structure in one release.
- Providing exactly-once delivery across external email and push providers. The system will provide durable intent, deterministic event identity, and controlled retries; provider-side side effects remain at-least-once unless the provider supports idempotency.
- Debouncing message submission as a substitute for backend idempotency.
- Changing the visual design.

## Observed production topology

Read-only inspection of the VPS on 2026-08-28 established these deployment constraints:

- Ubuntu/Linux host with 4 vCPUs, 7.6 GiB RAM, 1 GiB swap, and 72 GiB disk at 21% usage.
- Docker Engine 29.7.2 and Docker Compose 5.4.0.
- One running replica each of frontend, user-service, chat-service, notification-service, Nginx, PostgreSQL, Prometheus, and Grafana.
- Backend and Nginx images are pinned to backend commit `0ef2181`; frontend currently uses the mutable `latest` tag and is older than the backend deployment.
- Application containers are stateless and restart with policy `always`. Their limits are 128 MiB for Nginx, 256 MiB for frontend/user/notification, and 384 MiB for chat, with 0.25-0.5 CPU each.
- PostgreSQL 17 is local, limited to 512 MiB and 1 CPU, and persists through `chat-microservices_postgres-data`.
- The production database is approximately 8.3 MiB. Application table statistics report zero live rows, so the first additive migrations are small; production-safe index strategies remain required for future growth.
- RabbitMQ is external; there is no broker container in the Compose project.
- Redis is not deployed. Current production therefore cannot rely on the distributed presence adapter.
- Prometheus and Grafana persist data, but currently have no Docker memory or CPU limits.
- The Nginx container is a shared ingress gateway attached to the chat, n8n, and WorkSmart networks. Its effective configuration is bind-mounted from `/opt/worksmart/runtime/gateway-nginx.conf`, so ingress changes affect more than the chat project.
- Only Nginx publishes public ports 80/443. Prometheus and Grafana bind to loopback; application and PostgreSQL ports remain internal.

### Topology implications

- Additive PostgreSQL migrations can use ordinary transactional DDL at the current data size. Each migration still documents the concurrent-index alternative for future large tables.
- Outbox and delivery workers start with small batches and bounded concurrency to remain within current container limits.
- Distributed presence work includes deployment of an internal Redis service or an explicit managed-Redis decision; it cannot assume Redis already exists.
- RabbitMQ dead-letter and retry topology uses versioned exchanges and queues. Existing queue arguments are not mutated in place because the external broker rejects incompatible redeclarations.
- RabbitMQ rollout uses dual-publish/dual-consume compatibility before retiring the current `NOTIFICATIONS` queue.
- Frontend deployments use immutable SHA tags before coordinated API-contract rollout.
- Shared-gateway configuration changes require validation of chat, n8n, and WorkSmart routes before deployment.
- Prometheus and Grafana receive explicit resource limits before additional reliability metrics materially increase cardinality or retention pressure.

## Current risks

The adversarial review verified these failure modes:

1. REST message creation has no client idempotency key. A lost response followed by retry creates another durable message.
2. Message persistence commits before notification publication. RabbitMQ publication failure can silently lose notification intent.
3. Notification consumers have no event-level uniqueness. Broker redelivery can duplicate rows and external delivery, while `nack(..., requeue=false)` can discard transient failures.
4. RabbitMQ user-detail RPC replies use one shared response queue. With multiple chat-service replicas, a reply can be consumed and discarded by the wrong replica.
5. RabbitMQ reconnection schedules only one retry after a failure, and health checks can report stale channel objects as healthy.
6. Prekey publication performs read-then-insert without a unique `(userId, deviceId)` constraint. Concurrent operations can create conflicting cryptographic state.
7. Unauthenticated callers can consume one-time prekeys, while concurrent frontend first-sends can consume more than one key and race session creation.
8. Redis presence has a non-expiring online index that can suppress offline notifications after a process crash.
9. Generated frontend API types disagree with runtime envelopes, prekey shapes, message statuses, and login results.
10. Controllers combine transport, persistence, orchestration, raw SQL, and messaging concerns, and three RabbitMQ lifecycle implementations have drifted.

## Design principles

### Delivery semantics are explicit

- Database state changes and event intent are committed in one PostgreSQL transaction.
- RabbitMQ delivery is at-least-once.
- Every event has an immutable `eventId`.
- Every idempotent command has an immutable client-generated command ID.
- Consumers persist deduplication state before acknowledging a broker message.
- External delivery retries are recorded and observable.

### ACID applies inside service-owned data

PostgreSQL transactions protect invariants owned by one service. Cross-service work is coordinated through durable events, not distributed database transactions.

### Clean Architecture is introduced vertically

Each changed flow is organized into:

- domain values and invariants;
- an application use case;
- ports for persistence, events, time, and identity;
- TypeORM, RabbitMQ, Express, Socket.IO, and browser adapters.

Existing unaffected flows remain in place until touched. This avoids a prolonged rewrite branch.

### The server owns durable idempotency

Frontend guards improve user experience but are not correctness boundaries. PostgreSQL uniqueness is the final authority.

## Subproject 1: Toolchain, dependencies, and API contract integrity

### Package consistency

- Pin frontend `packageManager` to `pnpm@9.11.0`, matching CI.
- Declare supported Node versions through `engines` and CI.
- Keep pnpm overrides effective and verify them with a frozen-lockfile CI install.
- Add the Storybook packages used by source imports as direct development dependencies.
- Remove identical `* 2.*` conflict-copy files after confirming they are not referenced.
- Upgrade production dependencies that currently have critical/high advisories. Breaking upgrades receive focused tests before adoption; audit fixes are never applied with an unreviewed `--force`.

### Canonical HTTP contract

OpenAPI documents the actual wire format, including the shared response envelope and pagination fields. Generated frontend helpers expose the already-unwrapped application value returned by `ApiClient`; they do not add a second synthetic `data` envelope.

Canonical examples:

```ts
type ApiEnvelope<T> = {
  status: number
  message: string
  data?: T
}

type PublishedPrekeyBundle = {
  deviceId: string
  bundle: {
    registrationId: number
    identityKey: string
    signedPreKey: SignedPreKey
    preKeys: OneTimePreKey[]
  }
}

type ConsumedPrekeyBundle = {
  userId: string
  deviceId: string
  bundle: PublishedPrekeyBundle['bundle']
}
```

Login returns `void` at the generated service boundary because authentication state is established by the HTTP-only cookie. Search, conversations, and messages return arrays directly. Pagination is represented explicitly instead of being discarded during response normalization.

### Drift prevention

CI performs these deterministic steps:

1. Export backend OpenAPI documents.
2. Generate frontend types and helpers.
3. Fail if `git diff --exit-code` reports generated changes.
4. Type-check a small compile-only contract fixture that exercises login, search, prekeys, conversations, messages, and receipts.

Generated files contain a source hash and generator version. Production builds consume committed generated artifacts and do not fetch a live backend schema.

## Subproject 2: Idempotent message command and transactional outbox

### Public command

The frontend creates a UUID `clientMessageId` once, before encryption, and retains it across timeout retries. The REST command becomes:

```ts
type SendMessageCommand = {
  clientMessageId: string
  receiverId: string
  message: string
}
```

The encrypted envelope remains opaque to the server. A repeated `(senderId, clientMessageId)` command:

- returns the original message when receiver and encrypted payload match;
- returns HTTP 409 when the key is reused with different content or receiver;
- never writes a second message or second outbox event.

### PostgreSQL constraints

`messages` gains a nullable `clientMessageId` during the compatibility rollout and a partial unique index:

```sql
CREATE UNIQUE INDEX messages_sender_client_id_unique
ON messages ("senderId", "clientMessageId")
WHERE "clientMessageId" IS NOT NULL;
```

New clients always send the field. After old-client compatibility expires, a later migration makes it required.

### Send-message use case

Both REST and any future WebSocket command call one `SendMessage` application use case. The current frontend REST-then-WebSocket persistence replay is removed. Socket.IO becomes a delivery adapter, not a second persistence command path.

Within one database transaction, the use case:

1. validates sender, receiver, command ID, and encrypted envelope;
2. inserts or retrieves the idempotent message;
3. inserts one `message.created` outbox record with a deterministic event ID;
4. commits;
5. returns the persisted message immediately.

### Outbox schema

Each producing service owns an `outbox_events` table:

```ts
type OutboxEvent = {
  id: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: unknown
  occurredAt: Date
  publishedAt: Date | null
  attempts: number
  nextAttemptAt: Date
  lastError: string | null
}
```

The relay claims batches with `FOR UPDATE SKIP LOCKED`, publishes through a confirm channel, and marks `publishedAt` only after broker confirmation. Failed attempts use bounded exponential backoff with jitter. Permanently failing rows remain queryable and produce metrics/alerts.

### Status transitions

Message status is monotonic:

```text
NotDelivered -> Delivered -> Seen
NotDelivered -------------> Seen
```

Updates include the authenticated owner predicate and a status predicate. Repeated receipts are successful no-ops. A late `Delivered` event never downgrades `Seen`.

## Subproject 3: Reliable RabbitMQ and notification processing

### Shared messaging adapter

A backend workspace package provides the common RabbitMQ connection lifecycle:

- confirm-channel publishing;
- exponential reconnect with jitter and repeated scheduling;
- connection/channel invalidation on close;
- accurate readiness and liveness state;
- graceful shutdown;
- structured metrics for reconnects, publish confirms, nacks, retries, and dead letters.

Domain event names and payload types remain service-owned; the shared package contains infrastructure behavior only.

### Topology

Use a durable topic exchange with service-owned durable queues. Each consumer queue has:

- manual acknowledgements;
- a retry path with bounded attempts and increasing delay;
- a dead-letter queue for exhausted or invalid messages;
- documented routing keys and ownership.

Invalid schemas are dead-lettered immediately. Transient database or provider failures enter the retry path.

Because production RabbitMQ is external and the current queue was declared without dead-letter arguments, the new topology uses versioned names such as `chat.events.v2`, `notifications.v2`, `notifications.retry.v2`, and `notifications.dlq.v2`. Deployment temporarily dual-publishes and validates the new consumer before the original queue is retired.

### Replica-safe RPC

User-detail lookup no longer uses one shared reply queue. The migration uses RabbitMQ direct reply-to or an exclusive, auto-delete reply queue per process. Correlation callbacks are process-local, timed out, and cleared during shutdown/reconnect.

The send-message HTTP request never waits for this RPC. Notification enrichment happens asynchronously after the message transaction commits.

### Notification inbox and delivery jobs

The notification service records an incoming event and its resulting work in one transaction:

```ts
type InboxEvent = {
  eventId: string
  eventType: string
  receivedAt: Date
  processedAt: Date | null
}

type DeliveryJob = {
  id: string
  eventId: string
  channel: 'email' | 'push'
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  nextAttemptAt: Date
  lastError: string | null
}
```

`inbox_events.eventId` is unique. Repeated broker delivery acknowledges the already-processed event without duplicating a notification or delivery job.

The broker message is acknowledged after durable inbox processing, not after email/push completes. Separate workers claim delivery jobs with `FOR UPDATE SKIP LOCKED`. Email uses a deterministic `Message-ID` derived from `eventId`; provider idempotency keys are used when supported.

## Subproject 4: Prekeys, Signal sessions, and presence

### Separate key responsibilities

Published X3DH bundles and encrypted local-key backups are stored in separate tables. A single JSON column no longer alternates between unrelated shapes.

`published_prekeys` has a unique `(userId, deviceId)` constraint. Publication uses one atomic `INSERT ... ON CONFLICT DO UPDATE` operation. `signal_key_backups` has the same ownership constraint and cannot be returned by the public prekey endpoint.

### Authenticated one-time-prekey consumption

Prekey consumption requires an authenticated initiator. Rate limits apply to authenticated initiator ID and target user ID, with IP limiting as a secondary control.

The transaction locks the single unique device row, consumes at most one prekey, persists the shortened pool, and returns the exact consumed bundle. Pool exhaustion increments metrics and returns signed-prekey material according to the documented fallback policy.

### Frontend session mutex

The frontend owns one in-flight session-establishment promise per `(currentUserId, recipientId)`. Concurrent sends await the same promise. Cleanup occurs in `finally`, and failures do not poison later attempts.

The mutex prevents duplicate prekey consumption; it does not debounce message submission.

### Presence source of truth

Redis presence is derived from expiring socket leases, not a non-expiring membership set. Each socket lease has a bounded TTL refreshed by heartbeat. Online queries atomically prune expired leases before returning status. A process crash therefore degrades to offline after the lease window instead of leaving the user online indefinitely.

Notification policy treats presence lookup failure as offline and continues durable notification processing.

Production rollout adds an internal-only Redis service with a 128 MiB memory limit and no public port, unless a managed Redis endpoint is selected before implementation. Presence is ephemeral, so Redis persistence is not required for correctness; expiry is the recovery mechanism.

## Subproject 5: Incremental Clean Architecture

New and modified flows use this dependency direction:

```text
Express / Socket.IO / RabbitMQ handlers
                |
                v
        Application use cases
                |
                v
 Domain values and repository/event ports
                ^
                |
 TypeORM / RabbitMQ / Redis / provider adapters
```

Initial use cases are:

- `SendMessage`
- `ApplyMessageReceipt`
- `PublishPrekeyBundle`
- `ConsumePrekeyBundle`
- `ProcessNotificationEvent`
- `DeliverNotification`

Controllers translate transport input/output only. They do not acquire global repositories, construct broker payloads, or issue raw SQL.

Repository ports expose intent-specific operations rather than generic CRUD. Transactions are represented by a unit-of-work boundary owned by the application use case.

### Tao of Node constraints

- Entry points compose dependencies and own process signals.
- Library modules do not call `process.exit`.
- Configuration is parsed and validated once at startup.
- Async failures are propagated or intentionally translated; they are not silently logged and swallowed.
- Modules export small explicit APIs and avoid mutable global lifecycle state.
- Resource shutdown is idempotent and safe after partial startup.
- Logs are structured and include request, command, event, and correlation IDs.

## Frontend resilience follow-ups

After the durable backend boundaries exist:

- deduplicate REST catch-up and WebSocket delivery by message ID;
- cancel or version user-search requests so stale results cannot overwrite newer ones;
- propagate notification mutation failures and roll back optimistic state;
- make locale initialization observable, with a bounded fallback that cannot permanently block authenticated routes;
- key typing timers by sender/receiver pair and clear them during disconnect;
- disable repeated submit for user feedback while preserving the same `clientMessageId` for retries.

## Testing strategy

All behavior changes follow red-green-refactor TDD.

### Unit tests

- command ID replay with identical and conflicting payloads;
- monotonic receipt transitions;
- outbox retry/backoff and confirm handling;
- consumer deduplication;
- reconnect state transitions and truthful health;
- prekey upsert and consumption invariants;
- session mutex success, failure, and cleanup;
- frontend stale-result and message deduplication behavior.

### Integration tests

Use real PostgreSQL, RabbitMQ, and Redis containers for:

- concurrent duplicate message commands;
- transaction rollback before outbox commit;
- relay crash after publish but before marking published;
- notification consumer crash before acknowledgement;
- two chat-service replicas performing simultaneous RPC calls;
- broker outage and recovery across repeated failed attempts;
- concurrent prekey publication and consumption;
- presence expiry after abrupt process termination.

### Contract tests

Generated frontend types compile against representative backend responses. CI verifies regenerated artifacts are clean.

### Adversarial test challenge

After each high-risk subproject, an independent test critic proposes missing boundary and interaction cases. Blocking cases are added with another TDD cycle before the subproject is considered complete.

## Rollout and migrations

Use expand-migrate-contract deployment sequencing:

1. Deploy additive database migrations and backward-compatible backend readers.
2. Deploy backend writers for new IDs, outbox, inbox, and delivery jobs.
3. Deploy the frontend that sends stable client message IDs and uses corrected contracts.
4. Observe duplicate, retry, dead-letter, outbox-lag, prekey-pool, and presence metrics.
5. Backfill or clean legacy rows where required.
6. Enforce non-null constraints and remove compatibility paths in a later release.

Migrations run transactionally per service. Large-table indexes use PostgreSQL's concurrent-index strategy where transaction restrictions require a dedicated migration.

Rollback retains additive columns and tables until the old application version is fully restored. Consumers tolerate unknown additive event fields.

## Observability and operational acceptance

Expose metrics for:

- idempotent replays and command conflicts;
- outbox pending count, age, attempts, and terminal failures;
- RabbitMQ connection state, reconnect attempts, confirms, nacks, retries, and DLQ depth;
- inbox duplicates;
- delivery-job attempts and final failures by channel;
- prekey pool levels, exhaustion, and rejected unauthenticated access;
- active and expired presence leases;
- generated-contract drift in CI.

Readiness fails when a required database connection is unavailable or the service cannot accept its owned work. Liveness does not fail merely because RabbitMQ is temporarily reconnecting. Health checks inspect actual connection/channel state, not object truthiness.

## Success criteria

The program is complete when:

- retrying a timed-out send never creates a second message;
- every committed message has a durable event intent;
- broker redelivery never creates a duplicate notification row;
- transient notification failures are retried and exhausted work is visible in a DLQ;
- multiple replicas receive only their own RPC replies;
- RabbitMQ recovery continues across repeated failures and health reflects reality;
- concurrent prekey operations preserve one row per user/device and consume at most one key per session establishment;
- crashed presence leases expire automatically;
- generated frontend contracts match runtime payloads and CI detects drift;
- all existing tests remain green and new concurrency/failure integration tests pass;
- production dependency audits contain no critical or high findings without an explicitly documented, time-bounded exception.
