# Chat Microservices Backend

This secure chat system uses Node.js, TypeScript, PostgreSQL, and real-time WebSocket communication. Its capacity can increase as demand increases.
The system uses the Signal Protocol for end-to-end encryption (E2EE).

<a id="️-architecture"></a>
## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          NGINX                                   │
│                    (Reverse Proxy + SSL)                         │
└───────────┬─────────────────┬─────────────────┬─────────────────┘
            │                 │                 │
    ┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
    │  User Service │ │  Chat Service │ │  Notification │
    │    (8081)     │ │    (8082)     │ │    Service    │
    │               │ │               │ │    (8083)     │
    └───────┬───────┘ └───────┬───────┘ └───────┬───────┘
            │                 │                 │
    ┌───────▼─────────────────▼─────────────────▼───────┐
    │                    PostgreSQL                       │
    │                      (5432)                         │
    └──────────────────────┬────────────────────────────┘
                           │
    ┌──────────────────────▼────────────────────────────┐
    │                    RabbitMQ                         │
    │               (Message Broker)                      │
    └─────────────────────────────────────────────────────┘
```

<a id="-quick-start"></a>
## Quick Start

```bash
# Clone and setup
git clone https://github.com/christiantroyandrada/chat-microservices.git
cd chat-microservices

# Configure environment
cp docker-secrets/app_secrets.example docker-secrets/app_secrets
# Edit app_secrets with your values

# Create distinct disposable keys for local Go authentication
export GO_WS_SESSION_KEY="$(openssl rand -hex 32)"
export GO_WS_BRIDGE_TOKEN="$(openssl rand -hex 32)"

# Start all services
docker compose up -d

# Verify health
curl http://localhost:80/health
```

The Go service is required. For production, keep its two distinct keys in Infisical and reuse them across releases.
See [the Go service guide](websocket-service/README.md) for transport limits and rollback checks.

<a id="-project-structure"></a>
## Project Structure

```
chat-microservices/
├── user-service/         # Authentication, user management, prekey storage
├── chat-service/         # REST messages, conversations, durable outbox
├── websocket-service/    # Go delivery, receipts, typing, presence
├── notification-service/ # Email notifications, push notifications
├── nginx/               # Reverse proxy configuration
├── deploy/              # Deployment scripts and guides
├── scripts/             # Utility scripts (cron jobs, maintenance)
└── docker-compose.yml   # Development environment
```

<a id="-security-features"></a>
## Security Features

- The system uses **JWT Authentication** with httpOnly cookies.
- The system uses **End-to-End Encryption** (Signal Protocol - X3DH + Double Ratchet).
- The client uses **Client-Side Key Encryption** (AES-256-GCM, PBKDF2 100k iterations).
- The system uses **bcrypt** password hashing (cost factor 12).
- The system uses **Helmet.js** security headers.
- The system applies **Rate Limiting** globally and to authentication requests.
- The system uses **Input Validation** (express-validator).
- The system uses **SQL Injection Protection** (TypeORM parameterized queries).
- The system uses **Distroless Docker Images** to minimize components that attackers can exploit.

See [SECURITY.md](./SECURITY.md) for complete security documentation.

<a id="-testing"></a>
## Testing

```bash
# Run tests for each service
cd user-service && npm run test:unit
cd chat-service && npm run test:unit
cd notification-service && npm run test:unit
```

<a id="-documentation"></a>
## Documentation

| Document | Description |
|----------|-------------|
| [SECURITY.md](./SECURITY.md) | Security guidelines and audit results |
| [deploy/README.md](./deploy/README.md) | Deployment guide |
| [deploy/GITHUB_SECRETS.md](./deploy/GITHUB_SECRETS.md) | CI/CD secrets setup |
| [docs/SSL_SETUP.md](./docs/SSL_SETUP.md) | SSL/HTTPS configuration |

<a id="️-tech-stack"></a>
## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 22 |
| Language | TypeScript 5.9 |
| Framework | Express.js |
| Database | PostgreSQL 17 + TypeORM |
| Message Queue | RabbitMQ |
| Real-time | Go WebSocket service |
| Security | JWT, bcrypt, Helmet.js |
| Container | Docker (distroless) |
| CI/CD | GitHub Actions |

<a id="-license"></a>
## License

MIT License - see LICENSE file for details.
