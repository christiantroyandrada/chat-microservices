# Chat Microservices

This repository contains a small set of Node.js + TypeScript microservices for a chat system: an API Gateway, a User (auth) service, a Chat (messages) service, and a Notification service. Services communicate via RabbitMQ and use MongoDB where applicable.

## Repository layout

- `gateway/` — HTTP gateway that proxies requests to internal services (default port 8080).
- `user-service/` — authentication and user management (default port 8081).
- `chat-service/` — message storage and messages API + socket support (default port 8082).
- `notification-service/` — email / push notification sender and queue consumer (default port 8083).
- `docker-compose.yml` — orchestrates MongoDB, mongo-express, services, and nginx for local dev.

## Quick overview

- Gateway routes (default):
  - `/api/user` -> user-service (http://localhost:8081)
  - `/api/chats` -> chat-service (http://localhost:8082)
  - `/api/notifications` -> notification-service (http://localhost:8083)

- Inter-service messaging: RabbitMQ (services read `MESSAGE_BROKER_URL`)
- Databases: MongoDB used by `user-service` and `chat-service` (services read `MONGO_URI` or `MONGO_URI` built from secrets)

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

# then start the stack
docker-compose up -d --build
```

The secret file is mounted into containers at `/run/secrets/app_secrets` (dotenv-style key=values). Note: containers do not automatically export those keys as environment variables — you can either continue using `.env` (current default behavior), or add an entrypoint wrapper that sources `/run/secrets/app_secrets` and exports variables before launching the app.

If you prefer `.env` per service, copy each service's `.env.example` into the service folder as before.

## Docker / docker-compose (local)

The compose file brings up:
- `mongodb` (mongo:8.2.1)
- `mongo-express` (web UI, host port 8088) — protected with basic auth
- `user`, `chat`, `notification` services (Node.js)
- `nginx` (reverse proxy, host port 85)

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
cp .env.example .env
npm install
npm run dev
```

Repeat for `chat-service` and `notification-service` when working on them individually.

## Troubleshooting

- If services fail to authenticate to MongoDB, make sure either:
  - your `.env` values (MONGO_URI) are correct, or
  - `docker-secrets/app_secrets` contains the correct ADMIN_USERNAME / ADMIN_PASSWORD and the compose stack was recreated.
- To verify mongo-express connectivity from the host:

```bash
curl -I http://localhost:8088/ || true
# expected: HTTP/1.1 401 Unauthorized (if basic auth is configured)
```

- Useful checks:
  - `docker-compose ps` to inspect health states
  - `docker-compose logs --tail 200 <service>` to view recent logs
