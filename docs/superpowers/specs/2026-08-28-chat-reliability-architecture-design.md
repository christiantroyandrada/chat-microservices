# Chat Reliability Architecture Design

**Status:** Approved in chat on 2026-08-28

This historical design records the approval and requirements from 2026-08-28.
The approval applies to the design. It does not give release approval or authorize implementation during documentation conversion.

**Repositories:**

- Backend: `chat-microservices` (`main` baseline `0ef2181`)
- Frontend: `chat-microservices-frontend` (`master` baseline `935c573`)

## Purpose

Improve the chat application through incremental changes.
First, correct silent data loss, duplicate durable operations, cryptographic key races, and contract drift.
Then do the broader structural cleanup.

The target architecture permits incremental adoption and has these properties:

- Repeated public commands are idempotent. They do not repeat durable changes.
- Each PostgreSQL service boundary preserves atomicity, consistency, isolation, and durability (ACID).
- RabbitMQ delivery is at-least-once, with explicit duplicate prevention.
- Small application use cases operate behind ports and adapters.
- Operations report health, retries, and partial failure accurately.
- The architecture supports DRY, SOLID, Clean Architecture, and Tao of Node principles.

## Scope

This design covers these areas:

- Frontend package and tooling consistency and generated API contracts.
- Message creation, real-time delivery, receipts, and retries.
- Notification persistence and email and push delivery.
- RabbitMQ publication, consumers, RPC replies, reconnection, and health.
- Signal prekey publication, consumption, backup, and concurrent session creation.
- Redis presence correctness.
- Incremental separation of application, domain, and infrastructure boundaries.

## Non-goals

- The design does not replace PostgreSQL, RabbitMQ, Redis, Socket.IO, TypeORM, SvelteKit, or Signal protocol libraries.
- The design does not convert all existing code to a new folder structure in one release.
- The design does not provide exactly-once delivery across external email and push providers.
  The system provides durable intent, deterministic event identity, and controlled retries.
  Unless the provider supports idempotency, provider-side effects remain at-least-once.
- The design does not use delayed message submission as a substitute for backend idempotency.
- The design does not change the visual design.

## Observed production topology

A read-only inspection of the VPS on 2026-08-28 established these deployment constraints:

- Ubuntu/Linux host with 4 vCPUs, 7.6 GiB RAM, 1 GiB swap, and 72 GiB disk at 21% usage.
- Docker Engine 29.7.2 and Docker Compose 5.4.0.
- One running replica each of frontend, user-service, chat-service, notification-service, Nginx, PostgreSQL, Prometheus, and Grafana.
- Backend and Nginx images use backend commit `0ef2181`.
  The frontend uses the mutable `latest` tag and is older than the backend deployment.
- Application containers are stateless and restart with policy `always`.
  Memory limits are 128 MiB for Nginx, 256 MiB for frontend/user/notification, and 384 MiB for chat.
  Each container has 0.25-0.5 CPU.
- PostgreSQL 17 is local, limited to 512 MiB and 1 CPU, and persists through `chat-microservices_postgres-data`.
- The production database is approximately 8.3 MiB.
  Application table statistics report zero live rows. Therefore, the first additive migrations are small.
  Index strategies that are safe for production remain required for future growth.
- RabbitMQ is external. The Compose project has no broker container.
- Redis is not deployed. Current production therefore cannot rely on the distributed presence adapter.
- Prometheus and Grafana persist data, but currently have no Docker memory or CPU limits.
- The Nginx container is a shared ingress gateway attached to the chat, n8n, and WorkSmart networks.
  Its active configuration is bind-mounted from `/opt/worksmart/runtime/gateway-nginx.conf`.
  Thus, ingress changes affect more than the chat project.
- Only Nginx publishes public ports 80/443.
  Prometheus and Grafana bind to loopback. Application and PostgreSQL ports remain internal.

### Topology implications

- Additive PostgreSQL migrations can use ordinary transactional DDL at the current data size.
  Each migration still documents the concurrent-index alternative for future large tables.
- Outbox and delivery workers start with small batches and bounded concurrency to remain within current container limits.
- Distributed presence work includes deployment of an internal Redis service or an explicit managed-Redis decision.
  The implementation cannot assume that Redis already exists.
- RabbitMQ dead-letter and retry topology uses versioned exchanges and queues.
  Do not change existing queue arguments in place because the external broker rejects incompatible redeclarations.
- RabbitMQ rollout uses dual-publish/dual-consume compatibility before retiring the current `NOTIFICATIONS` queue.
- Frontend deployments use immutable SHA tags before coordinated API-contract rollout.
- Before deployment, shared-gateway configuration changes require validation of chat, n8n, and WorkSmart routes.
- Prometheus and Grafana receive explicit resource limits before additional reliability metrics materially increase cardinality or retention pressure.

## Current risks

The adversarial review confirmed these failure modes:

1. REST message creation has no client idempotency key. If a response is lost, a retry creates another durable message.
2. Message persistence commits before notification publication. A RabbitMQ publication failure can silently lose notification intent.
3. Notification consumers have no event-level uniqueness.
   Broker redelivery can duplicate rows and external delivery. `nack(..., requeue=false)` can discard transient failures.
4. RabbitMQ user-detail RPC replies use one shared response queue.
   With multiple chat-service replicas, the wrong replica can consume and discard a reply.
5. RabbitMQ reconnection schedules only one retry after a failure, and health checks can report stale channel objects as healthy.
6. Prekey publication performs read-then-insert without a unique `(userId, deviceId)` constraint. Concurrent operations can create conflicting cryptographic state.
7. Unauthenticated callers can consume one-time prekeys.
   Concurrent frontend first-sends can consume more than one key and cause conflicting session creation.
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

PostgreSQL transactions protect rules owned by one service.
Durable events coordinate work across services. The design does not use distributed database transactions.

### Clean Architecture is introduced vertically

Each changed flow has these parts:

- Domain values and invariants define the rules that remain true.
- An application use case coordinates the operation.
- Ports define interfaces for persistence, events, time, and identity.
- TypeORM, RabbitMQ, Express, Socket.IO, and browser adapters implement the interfaces.

Existing unaffected flows remain in place until a change is necessary. This prevents a prolonged rewrite branch.

### The server owns durable idempotency

Frontend guards improve the user experience, but they do not establish correctness. PostgreSQL uniqueness is the final authority.

## Subproject 1: Toolchain, dependencies, and API contract integrity

### Package consistency

- Pin frontend `packageManager` to `pnpm@9.11.0`, matching CI.
- Declare supported Node versions through `engines` and CI.
- Keep pnpm overrides effective. Do a check with a frozen-lockfile CI installation.
- Add the Storybook packages used by source imports as direct development dependencies.
- After you confirm that identical `* 2.*` conflict-copy files have no references, remove them.
- Upgrade production dependencies that currently have critical/high advisories.
  Before adoption, breaking upgrades receive focused tests.
  Never apply audit fixes with an unreviewed `--force`.

### Canonical HTTP contract

OpenAPI documents the actual wire format, including the shared response envelope and pagination fields.
Generated frontend helpers expose the application value that `ApiClient` already unwraps.
They do not add a second synthetic `data` envelope.

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

Login returns `void` at the generated service boundary because the HTTP-only cookie establishes authentication state.
Search, conversations, and messages return arrays directly.
Response normalization retains explicit pagination fields.

### Drift prevention

CI performs these deterministic steps:

1. Export backend OpenAPI documents.
2. Generate frontend types and helpers.
3. Fail if `git diff --exit-code` reports generated changes.
4. Type-check a small compile-only contract fixture that exercises login, search, prekeys, conversations, messages, and receipts.

Generated files contain a source hash and generator version.
Production builds use committed generated artifacts. They do not fetch a live backend schema.

## Subproject 2: Idempotent message command and transactional outbox

### Public command

Before encryption, the frontend creates one UUID `clientMessageId`.
The frontend retains it across timeout retries. The REST command becomes:

```ts
type SendMessageCommand = {
  clientMessageId: string
  receiverId: string
  message: string
}
```

The encrypted envelope remains opaque to the server. A repeated `(senderId, clientMessageId)` command:

- When the receiver and encrypted payload match, the command returns the original message.
- When the same key has different content or receiver, the command returns HTTP 409.
- The command never writes a second message or second outbox event.

### PostgreSQL constraints

`messages` gains a nullable `clientMessageId` during the compatibility rollout and a partial unique index:

```sql
CREATE UNIQUE INDEX messages_sender_client_id_unique
ON messages ("senderId", "clientMessageId")
WHERE "clientMessageId" IS NOT NULL;
```

New clients always send the field. After compatibility with old clients expires, a later migration makes the field required.

### Send-message use case

Both REST and any future WebSocket command call one `SendMessage` application use case.
The implementation removes the current frontend REST-then-WebSocket persistence replay.
Socket.IO becomes a delivery adapter. It is not a second persistence command path.

Within one database transaction, the use case:

1. It validates the sender, receiver, command ID, and encrypted envelope.
2. It inserts or retrieves the idempotent message.
3. It inserts one `message.created` outbox record with a deterministic event ID.
4. It commits the transaction.
5. It returns the persisted message immediately.

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

The relay claims batches with `FOR UPDATE SKIP LOCKED` and publishes through a confirm channel.
Only after broker confirmation, the relay marks `publishedAt`.
Failed attempts use bounded exponential backoff with jitter.
Exponential backoff increases retry delays. Jitter varies the delays to prevent simultaneous retries.
Permanently failing rows remain queryable and produce metrics/alerts.

### Status transitions

Message status is monotonic:

```text
NotDelivered -> Delivered -> Seen
NotDelivered -------------> Seen
```

Updates include the authenticated owner predicate and a status predicate.
Repeated receipts do not change state and succeed. A late `Delivered` event never changes `Seen` to `Delivered`.

## Subproject 3: Reliable RabbitMQ and notification processing

### Shared messaging adapter

A backend workspace package provides the common RabbitMQ connection lifecycle:

- The package publishes through confirm channels.
- The package schedules repeated reconnection with exponential delays and jitter.
- On closure, the package invalidates the connection/channel.
- The package reports accurate readiness and liveness state.
- The package supports orderly shutdown.
- The package provides structured metrics for reconnects, publish confirms, nacks, retries, and dead letters.

Services own their domain event names and payload types.
The shared package contains infrastructure behavior only.

### Topology

Use a durable topic exchange with service-owned durable queues. Each consumer queue has:

- Each queue requires manual acknowledgements.
- Each queue has a retry path with bounded attempts and increasing delay.
- Each queue has a dead-letter queue for exhausted or invalid messages.
- Each queue has documented routing keys and ownership.

The consumer sends invalid schemas to the dead-letter queue immediately.
Transient database or provider failures enter the retry path.

Production RabbitMQ is external. The current queue has no dead-letter arguments.
Therefore, the new topology uses versioned names such as `chat.events.v2`, `notifications.v2`, `notifications.retry.v2`, and `notifications.dlq.v2`.
Deployment temporarily publishes to both topologies.
Before deployment retires the original queue, it validates the new consumer.

### Replica-safe RPC

User-detail lookup no longer uses one shared reply queue.
The migration uses RabbitMQ direct reply-to or an exclusive, auto-delete reply queue for each process.
Correlation callbacks belong to one process and have timeouts. During shutdown or reconnection, the service clears them.

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

After durable inbox processing, the service acknowledges the broker message. It does not wait for email or push completion.
Separate workers claim delivery jobs with `FOR UPDATE SKIP LOCKED`.
Email uses a deterministic `Message-ID` derived from `eventId`.
When the provider supports idempotency keys, workers use them.

## Subproject 4: Prekeys, Signal sessions, and presence

### Separate key responsibilities

Separate tables store published X3DH bundles and encrypted local-key backups.
A single JSON column no longer alternates between unrelated shapes.

`published_prekeys` has a unique `(userId, deviceId)` constraint. Publication uses one atomic `INSERT ... ON CONFLICT DO UPDATE` operation. `signal_key_backups` has the same ownership constraint and cannot be returned by the public prekey endpoint.

### Authenticated one-time-prekey consumption

Prekey consumption requires an authenticated initiator.
Rate limits apply to the initiator ID and target user ID. IP limiting is a secondary control.

The transaction locks the single unique device row and consumes at most one prekey.
It stores the shortened pool and returns the exact consumed bundle.
When the pool is exhausted, the service increments metrics and returns signed-prekey material according to the documented fallback policy.

### Frontend session mutex

The frontend owns one active session-establishment promise for each `(currentUserId, recipientId)`.
Concurrent sends await the same promise. Cleanup occurs in `finally`, and failures do not prevent later attempts.

The mutex prevents duplicate prekey consumption. It does not delay message submission to combine repeated requests.

### Presence source of truth

Redis presence uses expiring socket leases instead of a non-expiring membership set.
Each socket lease has a bounded time to live (TTL). A heartbeat refreshes the lease.
Before status is returned, online queries atomically remove expired leases.
After a process crash, the user becomes offline when the lease window expires. The user does not remain online indefinitely.

If the presence lookup fails, the notification policy treats the user as offline and continues durable notification processing.

Unless a managed Redis endpoint is selected before implementation, production rollout adds an internal-only Redis service.
The service has a 128 MiB memory limit and no public port.
Presence is temporary, so correctness does not require Redis persistence. Lease expiration provides recovery.

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

Controllers translate transport input and output only.
They do not acquire global repositories, construct broker payloads, or issue raw SQL.

Repository ports expose operations for specified purposes rather than generic CRUD.
The application use case owns the unit-of-work boundary for transactions.

### Tao of Node constraints

- Entry points compose dependencies and own process signals.
- Library modules do not call `process.exit`.
- Configuration is parsed and validated once at startup.
- Asynchronous failures propagate or receive an intentional translation. The implementation does not silently record and ignore them.
- Modules export small explicit APIs and avoid mutable global lifecycle state.
- Resource shutdown is idempotent and safe after partial startup.
- Logs are structured and include request, command, event, and correlation IDs.

## Frontend resilience follow-ups

After the durable backend boundaries exist:

- Prevent duplicates in REST catch-up and WebSocket delivery by message ID.
- Cancel or version user-search requests so stale results cannot overwrite newer ones.
- Propagate notification mutation failures. Restore the state that existed before the optimistic change.
- Make locale initialization observable. Provide a bounded alternative that cannot permanently stop access to authenticated routes.
- Use the sender/receiver pair as the typing timer key. During disconnect, clear the timers.
- Disable repeated submission for user feedback. Preserve the same `clientMessageId` for retries.

## Testing strategy

All behavior changes must obey red-green-refactor test-driven development (TDD).

### Unit tests

- Test coverage includes command ID replay with identical and conflicting payloads.
- Test coverage includes monotonic receipt transitions.
- Test coverage includes outbox retry/backoff and confirm handling.
- Test coverage includes consumer duplicate prevention.
- Test coverage includes reconnect state transitions and accurate health.
- Test coverage includes prekey upsert and consumption invariants.
- Test coverage includes session mutex success, failure, and cleanup.
- Test coverage includes frontend stale-result behavior and message duplicate prevention.

### Integration tests

Use real PostgreSQL, RabbitMQ, and Redis containers for:

- The tests cover concurrent duplicate message commands.
- The tests cover transaction rollback before outbox commit.
- The tests cover a relay crash after publication but before the published mark.
- The tests cover a notification consumer crash before acknowledgement.
- The tests cover two chat-service replicas with simultaneous RPC calls.
- The tests cover broker outage and recovery across repeated failed attempts.
- The tests cover concurrent prekey publication and consumption.
- The tests cover presence expiry after abrupt process termination.

### Contract tests

Generated frontend types compile against representative backend responses.
CI confirms that regenerated artifacts have no changes.

### Adversarial test challenge

After each high-risk subproject, an independent test critic proposes missing boundary and interaction cases.
Before the subproject is complete, add blocking cases through another TDD cycle.

## Rollout and migrations

Use expand-migrate-contract deployment sequencing:

1. Deploy additive database migrations and backward-compatible backend readers.
2. Deploy backend writers for new IDs, outbox, inbox, and delivery jobs.
3. Deploy the frontend that sends stable client message IDs and uses corrected contracts.
4. Observe duplicate, retry, dead-letter, outbox-lag, prekey-pool, and presence metrics.
5. Backfill or clean legacy rows where required.
6. Enforce non-null constraints and remove compatibility paths in a later release.

Migrations run in a transaction for each service.
If transaction restrictions require a dedicated migration, large-table indexes use PostgreSQL's concurrent-index strategy.

Rollback retains additive columns and tables until the old application version is fully restored.
Consumers tolerate unknown additive event fields.

## Observability and operational acceptance

Expose metrics for:

- Metrics include idempotent replays and command conflicts.
- Metrics include outbox pending count, age, attempts, and terminal failures.
- Metrics include RabbitMQ connection state, reconnect attempts, confirms, nacks, retries, and dead-letter queue (DLQ) depth.
- Metrics include inbox duplicates.
- Metrics include delivery-job attempts and final failures by channel.
- Metrics include prekey pool levels, exhaustion, and rejected unauthenticated access.
- Metrics include active and expired presence leases.
- Metrics include generated-contract drift in CI.

If a required database connection is unavailable, readiness fails.
If the service cannot accept its work, readiness fails.
Liveness does not fail only because RabbitMQ temporarily attempts reconnection.
Health checks inspect actual connection and channel state instead of object truthiness.

## Success criteria

The program is complete only when all these conditions are true:

- A retry of a timed-out send never creates a second message.
- Every committed message has a durable event intent.
- Broker redelivery never creates a duplicate notification row.
- Transient notification failures receive retries. Exhausted work is visible in a DLQ.
- Multiple replicas receive only their own RPC replies.
- RabbitMQ recovery continues across repeated failures. Health reports reflect actual state.
- Concurrent prekey operations preserve one row per user/device. They consume at most one key per session establishment.
- After a process crash, presence leases expire automatically.
- Generated frontend contracts match runtime payloads. CI detects drift.
- All existing tests remain green. New concurrency/failure integration tests pass.
- Production dependency audits contain no critical or high findings without an explicitly documented, time-bounded exception.
