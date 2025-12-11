# Chat Microservices Backend

A secure, scalable chat system built with Node.js, TypeScript, PostgreSQL, and real-time WebSocket communication. Features end-to-end encryption (E2EE) using the Signal Protocol.

## 🏗️ Architecture

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

## 🚀 Quick Start

```bash
# Clone and setup
git clone https://github.com/christiantroyandrada/chat-user-microservice.git
cd chat-user-microservice

# Configure environment
cp docker-secrets/app_secrets.example docker-secrets/app_secrets
# Edit app_secrets with your values

# Start all services
docker compose up -d

# Verify health
curl http://localhost:85/health
```

## 📁 Project Structure

```
chat-microservices/
├── user-service/         # Authentication, user management, prekey storage
├── chat-service/         # Real-time messaging, WebSocket, conversations
├── notification-service/ # Email notifications, push notifications
├── nginx/               # Reverse proxy configuration
├── deploy/              # Deployment scripts and guides
├── scripts/             # Utility scripts (cron jobs, maintenance)
└── docker-compose.yml   # Development environment
```

## 🔒 Security Features

- **JWT Authentication** with httpOnly cookies
- **End-to-End Encryption** (Signal Protocol - X3DH + Double Ratchet)
- **Client-Side Key Encryption** (AES-256-GCM, PBKDF2 100k iterations)
- **bcrypt** password hashing (cost factor 12)
- **Helmet.js** security headers
- **Rate Limiting** (global + auth-specific)
- **Input Validation** (express-validator)
- **SQL Injection Protection** (TypeORM parameterized queries)
- **Distroless Docker Images** (minimal attack surface)

See [SECURITY.md](./SECURITY.md) for complete security documentation.

## 🧪 Testing

```bash
# Run tests for each service
cd user-service && npm run test:unit
cd chat-service && npm run test:unit
cd notification-service && npm run test:unit
```

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [SECURITY.md](./SECURITY.md) | Security guidelines and audit results |
| [deploy/README.md](./deploy/README.md) | Deployment guide |
| [deploy/GITHUB_SECRETS.md](./deploy/GITHUB_SECRETS.md) | CI/CD secrets setup |
| [docs/SSL_SETUP.md](./docs/SSL_SETUP.md) | SSL/HTTPS configuration |

## ��️ Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 22 |
| Language | TypeScript 5.4 |
| Framework | Express.js |
| Database | PostgreSQL 17 + TypeORM |
| Message Queue | RabbitMQ |
| Real-time | Socket.IO |
| Security | JWT, bcrypt, Helmet.js |
| Container | Docker (distroless) |
| CI/CD | GitHub Actions |

## 📄 License

MIT License - see LICENSE file for details.
