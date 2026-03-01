# ADR-001: Microservices Architecture

## Status

**Accepted** — 2025-01-03

## Context

The chat application requires a backend that can independently scale its user management, real-time messaging, and notification delivery functions. A monolithic design would couple all three concerns, making it difficult to scale the WebSocket-heavy chat layer independently of the CPU-light user/auth layer.

## Decision

Split the backend into three microservices behind an NGINX reverse proxy:

| Service | Port | Responsibility |
|---|---|---|
| **user-service** | 8081 | Authentication (JWT), user CRUD, profile management, pre-key bundles for Signal Protocol E2EE |
| **chat-service** | 8082 | REST message endpoints, Socket.IO real-time messaging, message persistence |
| **notification-service** | 8083 | Asynchronous notification delivery (email, push) via RabbitMQ queue consumption |

### Communication patterns

- **Synchronous**: `chat-service` → `user-service` via RabbitMQ RPC (`USER_DETAILS_REQUEST` / `USER_DETAILS_RESPONSE`) for username resolution.
- **Asynchronous**: `chat-service` & `user-service` → `notification-service` via `NOTIFICATIONS` queue (fire-and-forget fanout).
- **Client ↔ Server**: Socket.IO (WebSocket upgrade with HTTP long-polling fallback) via NGINX sticky routing.

### Data layer

All three services share a single PostgreSQL 17 database (`chat_db`) with schema isolation by convention (no shared tables). This was chosen for operational simplicity at current scale; a future ADR will address database-per-service migration when needed.

## Consequences

### Positive
- Independent deployability via Docker Compose service-level restarts.
- Horizontal scalability: chat-service (WebSocket-heavy) can scale independently.
- Fault isolation: notification-service failure does not block message delivery.
- Technology flexibility: services can adopt different Node.js versions or libraries independently.

### Negative
- Shared database creates implicit coupling at the data layer.
- RPC over RabbitMQ adds latency vs. in-process function calls.
- Operational complexity: 3 services + RabbitMQ + PostgreSQL + NGINX to monitor.
- In-memory state (activeUsers Map, typing timeouts) prevents horizontal scaling of chat-service without a shared store (e.g., Redis).

### Risks
- **Single database SPOF**: All services fail if PostgreSQL is down. Mitigation: deep health checks (implemented) + DB replication (future).
- **RabbitMQ dependency**: Message delivery stalls if RabbitMQ is unavailable. Mitigation: exponential backoff reconnection (implemented).

## References

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — system overview
- [SECURITY.md](../../SECURITY.md) — security posture documentation
