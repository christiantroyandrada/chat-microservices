# Chat Microservices

This repository contains a small set of Node.js + TypeScript microservices for a chat system: an API Gateway, a User (auth) service, a Chat (messages) service, and a Notification service. Services communicate via RabbitMQ and use MongoDB where applicable.

## Repository layout

- `gateway/` — HTTP gateway that proxies requests to internal services (runs standalone, not in docker-compose).
- `user-service/` — authentication and user management (port 8081).
- `chat-service/` — message storage and messages API + socket support (port 8082).
- `notification-service/` — email / push notification sender and queue consumer (port 8083).
- `docker-compose.yml` — orchestrates MongoDB, mongo-express, user/chat/notification services, and nginx.
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
│  │  setup   │→ │  mongodb     │  │  mongo-express     │   │
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
- `mongo-express` (web UI, host port 8088) — protected with basic auth
- `user`, `chat`, `notification` services (Node.js microservices)
- `nginx` (reverse proxy, host port 85)

**Note**: The `gateway` service is **not** included in docker-compose. It runs standalone. Services are accessible directly or via nginx.

Basic start (rebuild images):

```bash
docker-compose up -d --build
```

Recreate a single service (non-destructive):

```bash
# recreate mongo-express only
docker-compose up -d --no-deps --force-recreate mongo-express
```

Check status and logs:

```bash
docker-compose ps
docker-compose logs --tail 200 mongo-express
docker-compose logs --tail 200 mongodb
docker-compose logs --tail 200 user
```

Mongo-express is reachable on the host at http://localhost:8088/ (it will return HTTP 401 Unauthorized unless you provide the basic-auth credentials from `docker-secrets/app_secrets` or `.env`).

## Healthchecks

- `mongo-express` includes a Node-based healthcheck that attempts a real `ping` to MongoDB using the configured `ME_CONFIG_MONGODB_URL`.
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

### Verify mongo-express connectivity

```bash
curl -I http://localhost:8088/ || true
# expected: HTTP/1.1 401 Unauthorized (if basic auth is configured)
```

### General debugging

- Check service health: `docker-compose ps`
- View logs: `docker-compose logs --tail 200 <service>`
- Restart a service: `docker-compose restart <service>`
- Check .env files were generated: `ls -la */service/.env`

### Services not connecting to RabbitMQ

- Verify `MESSAGE_BROKER_URL` in your consolidated secrets or `.env` files
- Check RabbitMQ is accessible (if using external instance)
- Review service logs for connection errors: `docker-compose logs --tail 100 user chat notification`
