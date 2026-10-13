# Chat Application — Architecture & Engineering Documentation

> Last updated: March 2026

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Service Interaction Flows](#service-interaction-flows)
4. [Backend Services](#backend-services)
5. [Frontend (SvelteKit)](#frontend-sveltekit)
6. [Security Model](#security-model)
7. [Resilience & Reliability](#resilience--reliability)
8. [Infrastructure & DevOps](#infrastructure--devops)
9. [Environment & Secrets](#environment--secrets)
10. [Performance Considerations](#performance-considerations)
11. [Conventions & Standards](#conventions--standards)
12. [Architecture Decision Records](#architecture-decision-records)
13. [Onboarding Guide](#onboarding-guide)

---

## Recent Engineering Improvements (March 2026)

This section records historical changes from March 2026. The results do not give release approval.

### Performance — 14 improvements across all services

| Area | Change | Impact |
|------|--------|--------|
| **chat-service: LRU user-detail cache** | The implementation replaced an unlimited `Map` with `LRUCache<string, …>` (max: 500 entries, 60s TTL via `lru-cache` v11). | The cache prevents memory leaks under sustained load. Cache access is bounded O(1). |
| **chat-service: UNION ALL CTE** | `getConversations` replaces the OR-query with `UNION ALL` CTE + `DISTINCT ON`. | The query prevents a full sequential scan and supports index use. |
| **chat-service: `presenceBulk` event** | On connection, `sendInitialPresence` sends one `presenceBulk` event instead of N individual `presence` events. | Socket messages change from O(n) to O(1). This reduces handshake delay for many users. |
| **chat-service: Map compaction** | `setInterval` (5 min) rebuilds `connectedUsers` and `typingTimeouts` maps from active entries. | This releases V8 internal map capacity that `delete()` alone cannot release. |
| **chat-service: `assertQueue` once** | Queue assertion moved to `connect()`. Previously, each publication asserted the queue. | The change removes unnecessary AMQP requests and responses. |
| **chat-service: `AddPerformanceIndexes` migration** | The migration adds a partial unread-message index, covering indexes on senderId/receiverId + createdAt DESC, and a composite status index. | Read queries are up to 10× faster on large tables. |
| **user-service: typed `publishNotification`** | The payload type changed from `payload: any` → `payload: Record<string, unknown>`. | The change removes the last `any` in the service. `assertQueue` moved to `connect()`. |
| **user-service: `AddTrigramSearchIndexes` migration** | The migration adds the `pg_trgm` extension + GIN indexes on `users.username` and `users.email`. | ILIKE search time increases less than proportionally to the data size. |
| **notification-service: template/logo caching** | `EmailTemplateService` caches HTML templates and the logo data URI on first read (O(1) thereafter). | The cache removes file I/O for each email send. |
| **notification-service: `UserStatusStore` Set** | The implementation changes `Record<string, boolean>` → `Set<string>`. It uses `delete()` in setUserOffline. | Memory has no entries with false values. The has/add/delete operations use O(1). |
| **chat-service + notification-service: `UserStatusStore` Set** | The chat-service uses the same Set migration. | The services use a consistent implementation. |
| **frontend: `presenceBulk` handler** | `websocket.service.ts` sends the `onlineUserIds` array to registered presence callbacks. | The handler matches the new server-side bulk event. |
| **frontend: parallel notification fetch** | `notification.store.ts` replaces sequential requests with `Promise.all`. | The change halves request and response time for initial notification loading. |
| **frontend: batched Signal decrypt** | `chat.service.ts` decrypts in groups of 20 (`BATCH_SIZE = 20`). It uses an LRU-bounded prekey cache (max 100). | The change keeps the interface thread available during large conversations. |

### Previous Improvements (June 2025 — FAANG production readiness review)

| Area | Change | Impact |
|------|--------|--------|
| **WebSocket Security** | The implementation removed the `receiveMessage` server-side relay. Clients can no longer send false messages to arbitrary users. | The change corrects a critical vulnerability. |
| **RabbitMQ Resilience** | All 3 services added exponential-backoff reconnection (max 10 attempts, 1s→30s). | The change prevents failures from spreading when the broker restarts. |
| **Health Checks** | Deep `/health` endpoints verify DB + RabbitMQ connectivity. On degradation, they return 503 with results for each check. | The results support container control and load balancer routing. |
| **Graceful Shutdown** | All services process SIGTERM/SIGINT with this sequence: drain HTTP → close RabbitMQ → close DB. | Deployments have zero downtime and leave no connections without an owner. |
| **Message Pagination** | `GET /chat/get/:receiverId` supports `?limit=50&offset=0` and returns `pagination` metadata. | Pagination prevents unlimited memory use for large conversations. |
| **Docker Compose** | The implementation added a RabbitMQ 3.13 service with a health check. All services depend on `rabbitmq: service_healthy`. | The Docker development environment operates correctly. |
| **CI/CD** | Each service has `npm audit` steps with `continue-on-error`. These replace the single `\|\| true` step. | Audit failures are visible for each service without stopping the pipeline. |
| **Dead Code** | The implementation removed `signal.ts.old`, the unused `getUserDetails` function, and the unnecessary `csrf-csrf` dependency. | The change reduces components that attackers can exploit and simplifies the dependency tree. |
| **Documentation** | The implementation added ADR-001 for the microservices rationale and a production incident runbook. | The documents help new contributors and operators respond to incidents. |

---

## System Overview

The secure, real-time chat application uses **end-to-end encryption (E2EE)** through the Signal Protocol.
The application has a microservices architecture with these components:

| Layer | Technology |
|-------|-----------|
| **Frontend** | SvelteKit 2 + Svelte 5 (Runes API) + Tailwind CSS 4 |
| **API Gateway** | Nginx (reverse proxy, SSL termination, rate limiting) |
| **Auth & Users** | user-service (Express.js + TypeORM + PostgreSQL) |
| **Messaging** | chat-service (Express.js + Socket.IO + TypeORM + PostgreSQL) |
| **Notifications** | notification-service (Express.js + RabbitMQ + Nodemailer) |
| **Database** | PostgreSQL 17 |
| **Message Queue** | RabbitMQ |
| **Container Runtime** | Docker (distroless production images) |
| **CI/CD** | GitHub Actions |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           INTERNET                                       │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │     NGINX       │
                    │  (Port 80/443)  │
                    │  Rate Limiting  │
                    │  Security Hdrs  │
                    │  Gzip Compress  │
                    └──┬──────┬───┬──┘
                       │      │   │
          ┌────────────┘      │   └────────────┐
          │                   │                │
  ┌───────▼───────┐  ┌───────▼───────┐  ┌────▼──────────┐
  │ user-service  │  │ chat-service  │  │ notification  │
  │   (8081)      │  │   (8082)      │  │   service     │
  │               │  │               │  │   (8083)      │
  │ • Auth (JWT)  │  │ • REST API    │  │               │
  │ • User CRUD   │  │ • WebSocket   │  │ • Email       │
  │ • Prekey Mgmt │  │ • Socket.IO   │  │ • Push (FCM)  │
  │ • Key Backup  │  │ • Presence    │  │ • DB Notifs   │
  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
          │                   │                  │
          │      ┌────────────┤                  │
          │      │            │                  │
  ┌───────▼──────▼────────────▼──────────────────▼───────┐
  │                   PostgreSQL 17                        │
  │                     (Port 5432)                        │
  │  Tables: users, prekeys, messages, notifications       │
  │  Features: UUID PKs, JSONB, connection pooling         │
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌────────────────────────▼─────────────────────────────┐
  │                    RabbitMQ                            │
  │              (Message Broker)                          │
  │  Queues:                                               │
  │  • USER_DETAILS_REQUEST / USER_DETAILS_RESPONSE        │
  │  • NOTIFICATIONS                                       │
  └───────────────────────────────────────────────────────┘
```

### Frontend Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SvelteKit App                          │
│                                                           │
│  Routes:                                                  │
│  ├── / (redirect)                                        │
│  ├── /login                                              │
│  ├── /register                                           │
│  └── /chat (main app)                                    │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Components  │  │   Services   │  │     Stores     │  │
│  │             │  │              │  │                │  │
│  │ ChatList    │  │ api.ts       │  │ auth.store     │  │
│  │ ChatHeader  │  │ auth.service │  │ chat.store     │  │
│  │ MessageList │  │ chat.service │  │ notification   │  │
│  │ MessageInput│  │ websocket    │  │ theme.store    │  │
│  │ Notif Modal │  │ notification │  │ toast.store    │  │
│  │ ThemeToggle │  │ dev-logger   │  │                │  │
│  │ Toast       │  │              │  │                │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐│
│  │              Signal Protocol (E2EE)                   ││
│  │  ┌──────────┐ ┌───────────┐ ┌──────────────────┐    ││
│  │  │ Facade   │ │ Sessions  │ │  Key Management  │    ││
│  │  │ (init/   │ │ (encrypt/ │ │  (generate/      │    ││
│  │  │  state)  │ │  decrypt) │ │   publish/backup)│    ││
│  │  └──────────┘ └───────────┘ └──────────────────┘    ││
│  │  ┌──────────┐ ┌───────────┐ ┌──────────────────┐    ││
│  │  │ Store    │ │ Backup    │ │  Key Encryption  │    ││
│  │  │ (IDB)   │ │ (restore) │ │  (AES-256-GCM)   │    ││
│  │  └──────────┘ └───────────┘ └──────────────────┘    ││
│  │  ┌──────────────────────────────────────────────┐    ││
│  │  │  Message Store (IndexedDB decrypted cache)   │    ││
│  │  └──────────────────────────────────────────────┘    ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

---

## Service Interaction Flows

### Authentication Flow

```
Client → POST /user/register → user-service → PostgreSQL (create user)
                                             → RabbitMQ (USER_REGISTERED event)
                                             → Set httpOnly JWT cookie
                                             
Client → POST /user/login → user-service → PostgreSQL (verify credentials)
                                          → Set httpOnly JWT cookie

Client → GET /user/me → user-service → Verify JWT → Return user data
```

### Message Send Flow (E2EE)

```
1. Sender: initSignal() → Load/generate Signal keys from IndexedDB
2. Sender: GET /api/user/prekeys/:recipientId → Fetch recipient's prekey bundle
3. Sender: createSessionWithPrekeyBundle() → X3DH key exchange
4. Sender: encryptMessage() → Double Ratchet encryption
5. Sender: POST /chat/send → Send encrypted envelope to chat-service
6. chat-service: Store encrypted message in PostgreSQL
7. chat-service: WebSocket emit 'receiveMessage' to recipient room
8. chat-service: If recipient offline → RabbitMQ (MESSAGE_RECEIVED event)
9. notification-service: Create DB notification + optional email
10. Recipient: Receive via Socket.IO → decryptMessage() → Display plaintext
```

### Real-time Messaging (WebSocket)

```
Client → Socket.IO connect (with JWT cookie) → chat-service
       → Join userId room
       → Receive 'presence' events for all online users
       
Client → 'sendMessage' event → Validate → Save to DB → Emit to recipient
Client → 'typing' event → Broadcast to recipient (3s auto-timeout)
Client ← 'receiveMessage' → Decrypt with Signal → Display
Client ← 'presence' → Update online/offline status
```

---

## Backend Services

### user-service (Port 8081)

**Responsibility**: The user-service authenticates users, manages users, and stores Signal Protocol prekeys.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /register` | No | Create account (rate limited) |
| `POST /login` | No | Authenticate (rate limited) |
| `GET /me` | JWT | Get current user |
| `POST /logout` | No | Clear JWT cookie |
| `GET /search?q=` | JWT | Search users |
| `GET /users/:userId` | JWT | Get user by ID |
| `POST /prekeys` | JWT | Publish prekey bundle |
| `GET /prekeys/:userId` | Rate limited | Get prekey bundle (public) |
| `POST /signal-keys` | JWT | Store encrypted key backup |
| `GET /signal-keys?deviceId=` | JWT | Retrieve encrypted key backup |

### chat-service (Port 8082)

**Responsibility**: The chat-service stores messages, sends real-time messages through WebSocket, and tracks user presence.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /send` | JWT | Send encrypted message |
| `GET /get/:receiverId` | JWT | Fetch conversation (paginated: `?limit=50&offset=0`) |
| `GET /conversations` | JWT | List all conversations |
| `PUT /messages/read/:senderId` | JWT | Mark messages as read |

**WebSocket Events** (Socket.IO at `/chat/socket.io`):

| Event | Direction | Description |
|-------|-----------|-------------|
| `sendMessage` | Client → Server | Send message with ack callback |
| `receiveMessage` | Server → Client | New message notification |
| `typing` | Bidirectional | Typing indicator (3s auto-timeout) |
| `presence` | Server → Client | Online/offline status change for a single user |
| `presenceBulk` | Server → Client | Bulk initial presence on connect: `{ onlineUserIds: string[] }` (replaces N individual `presence` emits) |

### notification-service (Port 8083)

**Responsibility**: The notification-service stores notifications, delivers email, and sends push notifications.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /notifications/` | JWT | List notifications |
| `GET /notifications/unread/count` | JWT | Unread count |
| `PUT /notifications/:id/read` | JWT | Mark as read |
| `PUT /notifications/read-all` | JWT | Mark all as read |
| `DELETE /notifications/:id` | JWT | Delete notification |
| `POST /notifications/` | JWT | Create notification |

**RabbitMQ Consumers**: The notification-service reads the `NOTIFICATIONS` queue.
- `MESSAGE_RECEIVED`: The service creates a database notification.
  If the recipient is offline, the service also sends email.
- `USER_REGISTERED`: The service creates a welcome notification and email.

---

## Security Model

### Defense in Depth

```
Layer 1: Nginx          → Rate limiting, security headers, CSP, HSTS
Layer 2: Express        → Helmet.js, CORS, body limits, input validation
Layer 3: Auth           → JWT httpOnly cookies, bcrypt (cost 12), session expiry
Layer 4: Data           → TypeORM parameterized queries, UUID PKs
Layer 5: Encryption     → Signal Protocol E2EE (X3DH + Double Ratchet)
Layer 6: Key Management → Client-side AES-256-GCM encryption, PBKDF2 (100k iter)
Layer 7: Container      → Distroless images, non-root, pinned digests
Layer 8: CI/CD          → npm audit, Trivy scanning, TypeScript checks
```

### Key Security Features

| Feature | Implementation |
|---------|---------------|
| Password hashing | bcrypt, cost factor 12 |
| JWT tokens | httpOnly, Secure (prod), SameSite, 1-day expiry |
| E2EE | Signal Protocol (X3DH + Double Ratchet) |
| Key backup | AES-256-GCM + PBKDF2 (100k iterations) |
| XSS prevention | CSP headers, input sanitization, HTML entity encoding |
| CSRF protection | SvelteKit origin verification + SameSite cookies |
| SQL injection | TypeORM parameterized queries |
| Rate limiting | Nginx (30r/s global, 5r/s auth) + Express (per-service) |
| Container security | Distroless, non-root, digest-pinned images |

---

## Resilience & Reliability

### RabbitMQ Reconnection

All three services reconnect automatically with exponential backoff. Exponential backoff increases the delay between connection attempts:

```
Attempt 1: wait 1s   → reconnect
Attempt 2: wait 2s   → reconnect
Attempt 3: wait 4s   → reconnect
...
Attempt N: wait min(2^N * 1000, 30000)ms → reconnect
Max attempts: 10 (then logs critical failure, service degrades gracefully)
```

The `RabbitMQService` class exposes:
- `isHealthy(): boolean` returns `true` only when both the connection and channel are active.
- `disconnect(): Promise<void>` closes the channel, then the connection. The service uses this method during shutdown.

### Deep Health Checks

Each service exposes `GET /health`. This endpoint returns the responses that follow:

```json
// Healthy (200)
{ "status": "ok", "checks": { "database": "ok", "rabbitmq": "ok" } }

// Degraded (503)
{ "status": "degraded", "checks": { "database": "ok", "rabbitmq": "fail" } }
```

Docker Compose `healthcheck` and orchestrators use this endpoint to determine whether a service is ready.

### Graceful Shutdown

On `SIGTERM` or `SIGINT`, the service obeys this shutdown sequence.
Examples include `docker stop` and Kubernetes pod termination.

```
1. Stop accepting new HTTP connections (server.close())
2. Close RabbitMQ channel + connection (rabbitMQService.disconnect())
3. Close PostgreSQL connection pool (AppDataSource.destroy())
4. Exit with code 0
```

`uncaughtException` and `unhandledRejection` also trigger shutdown with exit code 1.

---

## Infrastructure & DevOps

### Docker Composition

```
docker-compose.yml          → Development environment (HTTP, auto-sync)
docker-compose.prod.yml     → Production overrides (HTTPS, NODE_ENV=production)
```

**Services**: `user-service`, `chat-service`, `notification-service`, `postgres`, `rabbitmq`, `nginx`

All backend services declare `depends_on` with `condition: service_healthy` for both `postgres` and `rabbitmq`.
These conditions ensure that the infrastructure is ready before application containers start.

**RabbitMQ**: The service uses `rabbitmq:3.13-management-alpine` and the `rabbitmq-diagnostics -q ping` healthcheck.
The management interface is available at `localhost:15672`.

**Build Strategy**: Multi-stage builds
1. **Builder stage**: `node:22-trixie-slim` — Install, compile TypeScript
2. **Runtime stage**: `gcr.io/distroless/nodejs22-debian13:nonroot` — Minimal runtime

### CI/CD Pipeline (GitHub Actions)

```
Push to main:
  ├── Build & Audit (per-service, continue-on-error for visibility)
  ├── TypeScript Type Check
  ├── Security Audit (npm audit per-service + Trivy scanning)
  ├── Unit Tests & Coverage
  └── Docker Build & Push (GHCR)

Push to feature/*:
  ├── Build & Audit
  ├── TypeScript Type Check
  └── Unit Tests
  
Scheduled (Weekly):
  └── Security Audit (npm audit + Trivy)
```

---

## Environment & Secrets

### Local Development

```
docker-secrets/app_secrets     → Single consolidated secrets file (gitignored)
docker-secrets/app_secrets.example → Template with placeholder values
scripts/generate-envs.sh       → Generates per-service .env files from app_secrets
```

### Secret Flow

```
app_secrets → generate-envs.sh → user-service/.env
                                → chat-service/.env
                                → notification-service/.env
```

### Required Environment Variables

| Variable | Service | Description |
|----------|---------|-------------|
| `DATABASE_URL` | All | PostgreSQL connection string |
| `JWT_SECRET` | All | JWT signing key (auto-generated if weak) |
| `MESSAGE_BROKER_URL` | All | RabbitMQ connection URL |
| `PORT` | All | Service port (8081/8082/8083) |
| `CORS_ORIGINS` | All | Comma-separated allowed origins |
| `USER_SERVICE_URL` | chat | Internal URL for user lookups |
| `SMTP_HOST/PORT/USER/PASS` | notification | Email configuration |
| `NOTIFICATIONS_QUEUE` | notification | RabbitMQ queue name |

---

## Performance Considerations

### Backend Optimizations

- **Connection pooling**: PostgreSQL uses a connection pool (min: 5, max: 20, idle: 30s).
- **LRU user-detail cache**: The chat-service uses `LRUCache<string, CachedUserDetail>` to prevent N+1 HTTP calls and limit memory use.
  The cache limits are max: 500 entries, 60s TTL via `lru-cache` v11.
  LRU removes the least recently used entries. TTL is the time before an entry expires.
- **Batch user lookups**: `fetchUserDetailsBatch()` requests uncached user details in parallel.
- **UNION ALL CTE queries**: `getConversations` uses a `UNION ALL` CTE + `DISTINCT ON` to list conversations with database indexes.
  A CTE is a common table expression.
- **Database indexes**: `AddPerformanceIndexes` adds a partial unread index, covering indexes on sender/receiver + `createdAt DESC`, and a composite read-status index.
  `AddTrigramSearchIndexes` adds `pg_trgm` GIN indexes for fast ILIKE user search.
- **`assertQueue` once**: All services assert their RabbitMQ queues once during `connect()`. They do not assert queues for each publication.
- **Query monitoring**: The services record queries that exceed 1000ms.
- **WebSocket presence**: The in-process `UserStatusStore` (`Set<string>`) prevents RPC for online checks.
  On connection, `presenceBulk` sends one socket message instead of N.
- **Map compaction**: At a 5-minute interval, `socketHandler` rebuilds Maps from active entries to release V8 internal capacity.
- **Offline-only notifications**: The service publishes RabbitMQ events only when the recipient is offline.
- **Template caching**: `EmailTemplateService` caches HTML templates and the logo data URI in memory (O(1) after first read).

### Frontend Optimizations

- **LRU prekey cache**: `LRUCache` stores prekey bundles (max 100 entries). The cache prevents repeated requests for each message.
- **Batched Signal decrypt**: The frontend decrypts messages in groups of 20 (`BATCH_SIZE`) to keep the interface thread available.
- **Parallel notification fetch**: `notification.store.ts` uses `Promise.all` to request notifications and the unread count simultaneously.
- **`presenceBulk` handling**: On connection, one socket event calls all registered presence callbacks.
- **IndexedDB message cache**: The frontend stores decrypted messages locally for immediate loading. It uses a compound index on `[senderId, receiverId]`.
- **Debounced typing**: Typing indicator events use a 300ms debounce delay.
- **Auto-scroll optimization**: The frontend scrolls automatically only when the user is near the bottom.
- **Abort controllers**: All API requests have a 10s timeout and support cancellation.
- **Local-first rendering**: The frontend does a check of the IndexedDB cache before it requests data from the server.

### Nginx Optimizations

- **Gzip compression**: Enabled for JSON, CSS, JS, XML, SVG
- **Keepalive connections**: 1000 requests per connection to upstreams
- **Rate limiting zones**: Global (30r/s), Auth (5r/s), WebSocket (10r/s)
- **TCP optimizations**: `tcp_nodelay` + `tcp_nopush` for reduced latency

---

## Conventions & Standards

### Code Standards

| Convention | Rule |
|-----------|------|
| Language | TypeScript strict mode |
| Naming | camelCase (variables/functions), PascalCase (classes/types/components) |
| File naming | kebab-case for files, PascalCase for components |
| Error handling | Custom `APIError` class with status codes |
| Logging | Centralized logger with levels (DEBUG/INFO/WARN/ERROR) |
| Validation | express-validator on all user inputs |
| Auth | JWT in httpOnly cookies, middleware-based |

### Folder Structure Convention

```
service/
├── src/
│   ├── config/          # Environment configuration
│   ├── controllers/     # Request handlers (thin, delegate to services)
│   ├── database/        # TypeORM entities, connection, migrations
│   │   ├── models/      # Entity definitions
│   │   └── migrations/  # Schema migrations
│   ├── middleware/       # Express middleware (auth, validation, errors)
│   │   └── validation/  # Input validation chains
│   ├── routes/          # Express route definitions
│   ├── services/        # Business logic & external integrations
│   ├── utils/           # Shared utilities (APIError, logger, helpers)
│   ├── websocket/       # Socket.IO handlers (chat-service only)
│   ├── types.ts         # Service-specific type definitions
│   └── server.ts        # Entry point
├── tests/
│   └── unit/            # Jest unit tests
├── Dockerfile           # Multi-stage distroless build
├── package.json
├── tsconfig.json
└── jest.config.js
```

---

## Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](docs/adr/001-microservices-architecture.md) | Microservices Architecture | Accepted |

See also: [Production Incident Runbook](docs/runbooks/incident-response.md)

---

## Onboarding Guide

### Prerequisites

- Node.js 22+
- Docker & Docker Compose
- pnpm (for frontend)

### Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd chat-app

# 2. Setup backend secrets
cp chat-microservices/docker-secrets/app_secrets.example \
   chat-microservices/docker-secrets/app_secrets
# Edit app_secrets with your values (JWT secrets auto-generated if missing)

# 3. Start backend services
cd chat-microservices
docker compose up -d

# 4. Verify health
curl http://localhost:80/health

# 5. Start frontend development server
cd ../chat-microservices-frontend
pnpm install
pnpm dev
# Open http://localhost:5173

# 6. Run tests
# Backend
cd chat-microservices/user-service && npm run test:unit
cd ../chat-service && npm run test:unit
cd ../notification-service && npm run test:unit

# Frontend
cd chat-microservices-frontend
pnpm test:unit
pnpm test:e2e  # (requires backend running)
```

### Development Workflow

1. Use feature branch names with the form `feature/description`.
2. Submit a pull request into `main` to start the full CI pipeline.
3. All tests and the security audit must pass.
4. Docker images are automatically built and pushed to GHCR on main.

### Key Files to Know

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Development environment |
| `docker-compose.prod.yml` | Production overrides |
| `nginx/nginx.conf` | API gateway configuration |
| `docker-secrets/app_secrets` | Consolidated secrets (gitignored) |
| `scripts/generate-envs.sh` | Secret distribution to services |
| `SECURITY.md` | Security documentation & audit results |

---

*When significant architectural changes are made, update this document.*
