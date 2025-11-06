# Chat Microservices

This repository contains a small set of Node.js + TypeScript microservices for a chat system: an API Gateway, a User (auth) service, a Chat (messages) service, and a Notification service. Services communicate via RabbitMQ and use MongoDB where applicable.

## Repository layout

- `gateway/` — HTTP gateway that proxies requests to internal services (runs standalone, not in docker-compose).
- `user-service/` — authentication and user management (port 8081).
- `chat-service/` — message storage and messages API + socket support (port 8082).
- `notification-service/` — email / push notification sender and queue consumer (port 8083).
- `docker-compose.yml` — orchestrates MongoDB, Nosqlclient (Mongoclient), user/chat/notification services, and nginx.
- `scripts/` — helper scripts including `generate-envs.sh` for automatic .env generation.
- `docker-secrets/` — consolidated secrets file (not committed) and example file.

## Quick overview

**Note**: The gateway is currently a standalone service and is **not included** in the docker-compose stack. To use it, run it separately with `npm run dev` in the gateway folder.

- Gateway routes (when running standalone):
  - `/api/user` -> user-service (http://localhost:8081)
  - `/api/chat` -> chat-service (http://localhost:8082)
  - `/api/notifications` -> notification-service (http://localhost:8083)

- Inter-service messaging: RabbitMQ (services read `MESSAGE_BROKER_URL`)
- Databases: MongoDB used by `user-service` and `chat-service` (services read `MONGO_URI` or `MONGO_URI` built from secrets)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Compose Stack                                       │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │  setup   │→ │  mongodb     │  │  nosqlclient       │   │
│  │ (one-run)│  │  :27017      │  │  localhost:8088    │   │
│  └──────────┘  └──────────────┘  └────────────────────┘   │
│                       ↓                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ user-service │  │ chat-service │  │ notification-svc │ │
│  │   :8081      │  │   :8082      │  │     :8083        │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│         ↓                  ↓                  ↓             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │           nginx (reverse proxy)                     │  │
│  │           localhost:85                              │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

    External (not in compose):
    ┌──────────────┐
    │   gateway    │  ← Run separately with npm
    │   :8080      │
    └──────────────┘

    External services (cloud or local):
    - RabbitMQ (MESSAGE_BROKER_URL)
    - SMTP server (for notifications)
```

## Prerequisites

- Node.js (v22+ recommended)
- npm (or yarn)
- Docker & docker-compose (recommended for the full stack)

Optional external services if not using Docker locally:
- MongoDB instance (local or remote)
- RabbitMQ instance (local or remote)
- SMTP server

## Secrets and .env (local development)

This project supports two local patterns for secrets:

1) Simple `.env` files (used by the services via dotenv) — good for quick local development.
2) A consolidated Docker secret file `docker-secrets/app_secrets` (recommended for local runs with `docker-compose`).

What we added
- `docker-secrets/app_secrets.example` — a tracked example file you can commit. Copy it to `docker-secrets/app_secrets` and fill in real values locally.
- `.gitignore` excludes the `docker-secrets/` folder and `.env` to avoid accidentally committing real secrets.

How to use the consolidated secret file (quick):

```bash
# copy the example to the real secret file (local only)
cp docker-secrets/app_secrets.example docker-secrets/app_secrets

# edit the file and replace CHANGEME with real credentials
editor docker-secrets/app_secrets

# restrict file permissions so only your user can read it
chmod 600 docker-secrets/app_secrets

# then start the stack (automatically generates .env files)
docker-compose up -d --build
```

The secret file is mounted into containers at `/run/secrets/app_secrets` (dotenv-style key=values). 

**Automatic .env generation**: When you run `docker-compose up`, a setup service automatically runs `scripts/generate-envs.sh` to create per-service `.env` files from the consolidated secrets. This means:
- ✅ Services work in Docker Compose (using the consolidated secrets)
- ✅ Services work locally in VS Code (using generated `.env` files)
- ✅ No manual `.env` copying needed

To manually regenerate `.env` files (useful for local development):

```bash
./scripts/generate-envs.sh         # Creates .env files if they don't exist
./scripts/generate-envs.sh --force # Overwrites existing .env files
```

## Docker / docker-compose (local)

The compose file brings up:
- `setup` — one-time service that generates .env files from consolidated secrets
- `mongodb` (mongo:8.2.1) — database for user and chat services
- `nosqlclient` (Mongoclient 4.0.1, web UI, host port 8088) — modern MongoDB admin interface
- `user`, `chat`, `notification` services (Node.js microservices)
- `nginx` (reverse proxy, host port 85)

**Note**: The `gateway` service is **not** included in docker-compose. It runs standalone. Services are accessible directly or via nginx.

Basic start (rebuild images):

```bash
docker-compose up -d --build
```

Recreate a single service (non-destructive):

```bash
# recreate nosqlclient only
docker-compose up -d --no-deps --force-recreate nosqlclient
```

Check status and logs:

```bash
docker-compose ps
docker-compose logs --tail 200 nosqlclient
docker-compose logs --tail 200 mongodb
docker-compose logs --tail 200 user
```

Nosqlclient (Mongoclient) is reachable on the host at http://localhost:8088/ — a modern web interface for MongoDB with query history, aggregation pipeline builder, and more features than mongo-express.

## Healthchecks

- `nosqlclient` includes a healthcheck that verifies the web UI is responding on port 3000.
- `mongodb` has a healthcheck that runs a ping command via mongosh.
- Services expose simple HTTP `/health` endpoints which are used by compose healthchecks.

## How to run services (development without Docker)

For quick local dev of an individual service (example: `user-service`):

```bash
cd user-service
cp .env.example .env  # or run ../scripts/generate-envs.sh from repo root
npm install
npm run dev
```

Repeat for `chat-service` and `notification-service` when working on them individually.

### Running the gateway (standalone)

The gateway is not part of docker-compose. To run it:

```bash
cd gateway
npm install
npm run dev  # starts on port 8080
```

The gateway proxies requests to the backend services:
- `http://localhost:8080/api/user` → user-service (port 8081)
- `http://localhost:8080/api/chat` → chat-service (port 8082)
- `http://localhost:8080/api/notifications` → notification-service (port 8083)

## Helper Scripts

### Purge notification queue

The notification service includes a script to purge the RabbitMQ queue:

```bash
cd notification-service
node scripts/purgeQueue.js
```

This connects to RabbitMQ using `MESSAGE_BROKER_URL` and purges the `NOTIFICATIONS_QUEUE` (defaults to "NOTIFICATIONS"). Useful for clearing test messages during development.

## Troubleshooting

### MongoDB authentication issues

- If services fail to authenticate to MongoDB, make sure either:
  - your `.env` values (MONGO_URI) are correct, or
  - `docker-secrets/app_secrets` contains the correct ADMIN_USERNAME / ADMIN_PASSWORD and the compose stack was recreated.

### Verify Nosqlclient connectivity

```bash
curl -I http://localhost:8088/ || true
# expected: HTTP/1.1 200 OK (Nosqlclient UI is up)
```

Or simply open http://localhost:8088/ in your browser to access the Mongoclient interface.

### General debugging

- Check service health: `docker-compose ps`
- View logs: `docker-compose logs --tail 200 <service>`
- Restart a service: `docker-compose restart <service>`
- Check .env files were generated: `ls -la */service/.env`

### Services not connecting to RabbitMQ

- Verify `MESSAGE_BROKER_URL` in your consolidated secrets or `.env` files
- Check RabbitMQ is accessible (if using external instance)
- Review service logs for connection errors: `docker-compose logs --tail 100 user chat notification`

## Security

This project implements multiple security layers for local development and production readiness. See [SECURITY.md](./SECURITY.md) for detailed guidelines.

### Key Security Features

1. **Container Security**
   - All services run as non-root users
   - Admin UIs bound to localhost only (127.0.0.1)
   - Minimal Alpine-based images

2. **Dependency Security**
   - Automated npm audit in CI
   - Container image scanning with Trivy
   - Vulnerable packages removed (replaced sib-api-v3-typescript with axios)

3. **HTTP Hardening**
   - Helmet.js for security headers
   - Request body size limits (100KB)
   - Global rate limiting (100-200 requests/15min)
   - Strict auth rate limiting (10 requests/15min)
   - Input validation with express-validator
   - MongoDB injection protection with express-mongo-sanitize
   - Enhanced cookie security (httpOnly, secure, sameSite)

4. **Secrets Management**
   - Consolidated secrets file (gitignored)
   - No hardcoded credentials
   - Environment variable injection

5. **CI/CD Security**
   - Automated security scans on push/PR
   - Weekly scheduled security audits
   - TypeScript type checking

### Quick Security Checklist

Before deploying to production:
- [ ] Rotate all default credentials
- [ ] Enable HTTPS/TLS
- [ ] Set `NODE_ENV=production`
- [ ] Configure proper CORS origins
- [ ] Review rate limits for production traffic
- [ ] Enable `secure: true` for cookies
- [ ] Review and apply production recommendations in [SECURITY.md](./SECURITY.md)

For more details, see the [Security Guidelines](./SECURITY.md).

**Recent Security Improvements (Nov 2025)**: Input validation, MongoDB injection protection, environment validation, enhanced rate limiting, and improved cookie security. See [SECURITY_IMPROVEMENTS.md](./SECURITY_IMPROVEMENTS.md) for implementation details.
