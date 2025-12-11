# Chat Application — Architecture & Engineering Documentation

> Last updated: February 2026

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Service Interaction Flows](#service-interaction-flows)
4. [Backend Services](#backend-services)
5. [Frontend (SvelteKit)](#frontend-sveltekit)
6. [Security Model](#security-model)
7. [Infrastructure & DevOps](#infrastructure--devops)
8. [Environment & Secrets](#environment--secrets)
9. [Performance Considerations](#performance-considerations)
10. [Conventions & Standards](#conventions--standards)
11. [Onboarding Guide](#onboarding-guide)

---

## System Overview

A secure, real-time chat application featuring **end-to-end encryption (E2EE)** via the Signal Protocol. Built as a microservices architecture with:

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

**Responsibility**: Authentication, user management, Signal Protocol prekey storage

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

**Responsibility**: Message storage, real-time messaging via WebSocket, presence tracking

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /send` | JWT | Send encrypted message |
| `GET /get/:receiverId` | JWT | Fetch conversation |
| `GET /conversations` | JWT | List all conversations |
| `PUT /messages/read/:senderId` | JWT | Mark messages as read |

**WebSocket Events** (Socket.IO at `/chat/socket.io`):

| Event | Direction | Description |
|-------|-----------|-------------|
| `sendMessage` | Client → Server | Send message with ack callback |
| `receiveMessage` | Server → Client | New message notification |
| `typing` | Bidirectional | Typing indicator (3s auto-timeout) |
| `presence` | Server → Client | Online/offline status |

### notification-service (Port 8083)

**Responsibility**: Notification storage, email delivery, push notifications

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /notifications/` | JWT | List notifications |
| `GET /notifications/unread/count` | JWT | Unread count |
| `PUT /notifications/:id/read` | JWT | Mark as read |
| `PUT /notifications/read-all` | JWT | Mark all as read |
| `DELETE /notifications/:id` | JWT | Delete notification |
| `POST /notifications/` | JWT | Create notification |

**RabbitMQ Consumers**: `NOTIFICATIONS` queue
- `MESSAGE_RECEIVED` → Create DB notification + email (if recipient offline)
- `USER_REGISTERED` → Create welcome notification + email

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

## Infrastructure & DevOps

### Docker Composition

```
docker-compose.yml          → Development environment (HTTP, auto-sync)
docker-compose.prod.yml     → Production overrides (HTTPS, NODE_ENV=production)
```

**Build Strategy**: Multi-stage builds
1. **Builder stage**: `node:22-bookworm-slim` — Install, compile TypeScript
2. **Runtime stage**: `gcr.io/distroless/nodejs22-debian12:nonroot` — Minimal runtime

### CI/CD Pipeline (GitHub Actions)

```
Push to main:
  ├── Build & Audit (all services)
  ├── TypeScript Type Check
  ├── Security Audit (npm audit + Trivy scanning)
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

- **Connection pooling**: PostgreSQL pool (min: 5, max: 20, idle: 30s)
- **User detail caching**: In-memory cache with 60s TTL in chat-service (avoids N+1 HTTP calls)
- **Batch user lookups**: `fetchUserDetailsBatch()` parallelizes uncached lookups
- **Query monitoring**: Logs queries exceeding 1000ms
- **Database indexes**: Composite indexes on message (senderId + receiverId) and notification (userId + createdAt)
- **WebSocket presence**: In-process `UserStatusStore` avoids RPC for online checks
- **Offline-only notifications**: RabbitMQ events only published when recipient is offline

### Frontend Optimizations

- **Prekey bundle caching**: Session-scoped cache avoids re-fetching per message
- **IndexedDB message cache**: Decrypted messages stored locally for instant load
- **Debounced typing**: 300ms debounce on typing indicator events
- **Auto-scroll optimization**: Only scrolls when user is near bottom
- **Abort controllers**: All API requests have 10s timeout with cancellation support
- **Local-first rendering**: Check IndexedDB cache before server fetch

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

1. Feature branches: `feature/description`
2. PR into `main` triggers full CI pipeline
3. All tests must pass + security audit
4. Docker images auto-built and pushed to GHCR on main

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

*This document should be updated when significant architectural changes are made.*
