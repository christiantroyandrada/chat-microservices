# ADR-001: Microservices Architecture

## Status

**Accepted** — 2025-01-03

## Context

The chat application requires separate capacity increases for user management, real-time messaging, and notification delivery.

A monolithic design would combine these three functions. The chat layer uses many WebSocket connections. The user/auth layer uses little CPU capacity.
This combination would make independent capacity increases for the chat layer difficult.

## Decision

Split the backend into three microservices behind an NGINX reverse proxy:

| Service | Port | Responsibility |
|---|---|---|
| **user-service** | 8081 | Authentication (JWT), user CRUD, profile management, pre-key bundles for Signal Protocol E2EE |
| **chat-service** | 8082 | REST message endpoints, Socket.IO real-time messaging, message persistence |
| **notification-service** | 8083 | Asynchronous notification delivery (email, push) via RabbitMQ queue consumption |

### Communication patterns

- **Synchronous**: `chat-service` requests usernames from `user-service` through RabbitMQ remote procedure calls (RPC).
  The calls use `USER_DETAILS_REQUEST` / `USER_DETAILS_RESPONSE`.
- **Asynchronous**: `chat-service` and `user-service` send events to `notification-service` through the `NOTIFICATIONS` queue.
  Senders do not wait for a response. The queue distributes events to consumers.
- **Client ↔ Server**: Socket.IO uses NGINX routing that keeps each client connected to the same server.
  Socket.IO uses a WebSocket upgrade, with HTTP long-polling as an alternative.

### Data layer

All three services share one PostgreSQL 17 database (`chat_db`). By convention, each service uses separate tables.
The decision reduces operational work at the current scale. When separate databases become necessary, a future ADR will describe the migration.

## Consequences

### Positive
- Docker Compose can restart and deploy each service independently.
- The chat-service can use additional instances independently. It handles many WebSocket connections.
- A notification-service failure does not stop message delivery.
- Each service can use different Node.js versions or libraries independently.

### Negative
- The shared database creates dependencies between services at the data layer.
- RabbitMQ RPC takes more time than function calls within one process.
- Operators must monitor 3 services + RabbitMQ + PostgreSQL + NGINX.
- In-memory state includes the activeUsers Map and typing timeouts.
  The chat-service requires a shared store, such as Redis, before it can use additional instances.

### Risks
- **Single database SPOF**: A single point of failure (SPOF) can stop all services.
  If PostgreSQL stops, all services fail. Deep health checks are implemented. Database replication is planned.
- **RabbitMQ dependency**: If RabbitMQ is unavailable, message delivery stops temporarily.
  Reconnection with exponential backoff is implemented. Exponential backoff increases the delay between connection attempts.

## References

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — system overview
- [SECURITY.md](../../SECURITY.md) — security posture documentation
