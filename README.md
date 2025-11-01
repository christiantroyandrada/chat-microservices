# Chat Microservices

This repository contains a small set of Node.js + TypeScript microservices for a chat system: an API Gateway, a User (auth) service, a Chat (messages) service, and a Notification service. The services communicate via a message broker (RabbitMQ) and use MongoDB where applicable.

## Repository layout

- `gateway/` — HTTP gateway that proxies requests to internal services (default port 8080).
- `user-service/` — authentication and user management (default port 8081).
- `chat-service/` — message storage and messages API + socket support (default port 8082).
- `notification-service/` — email / push notification sender and queue consumer (default port 8083).
- `docker-compose.yml` — placeholder (empty); add a compose file to run the whole stack with Docker.

## Quick overview

- Gateway routes (default):
  - `/api/user` -> user-service (http://localhost:8081)
  - `/api/chats` -> chat-service (http://localhost:8082)
  - `/api/notifications` -> notification-service (http://localhost:8083)

- Inter-service messaging: RabbitMQ (services read `MESSAGE_BROKER_URL`)
- Databases: MongoDB used by `user-service` and `chat-service` (services read `MONGO_URI`)

## Prerequisites

- Node.js (v22+ recommended)
- npm (or yarn)
- MongoDB instance (local or remote)
- RabbitMQ instance (local or remote)
- SMTP server

Optional: Docker & docker-compose if you plan to containerize the stack.

## Per-service `.env` files

Each service loads environment from a `.env` file placed in the service folder. Copy the appropriate `.env.example` to `.env` and fill in the placeholder values before running a service locally. Example:

```bash
cd user-service
cp .env.example .env
npm install
npm run dev
```

Repeat for `chat-service` and `notification-service`. The `gateway` only proxies requests and typically doesn't require env vars, but a `.env.example` is included for convenience.

## How to run (local development)

1. Start MongoDB and RabbitMQ (or provide remote connection URLs).
2. For each service, create `.env` from the `.env.example` and edit the placeholders.
3. Start each service in its own terminal:

```bash
# gateway
cd gateway
npm install
npm run dev

# user-service
cd ../user-service
npm install
npm run dev

# chat-service
cd ../chat-service
npm install
npm run dev

# notification-service
cd ../notification-service
npm install
npm run dev
```

Notes:
- The notification service's `dev` script runs a purge script (`scripts/purgeQueue.js`) before starting. That script expects `MESSAGE_BROKER_URL` to be set. If you don't want the purge behavior, use `npm run dev-server` instead.

## Environment variables (summary)

Shared / common:
- `MONGO_URI` — MongoDB connection string (user & chat services)
- `PORT` — HTTP port for the service
- `JWT_SECRET` — secret for signing JSON Web Tokens
- `MESSAGE_BROKER_URL` — AMQP connection string for RabbitMQ (e.g., `amqp://localhost`)
- `NODE_ENV` — `development` or `production`

Notification service specific:
- `SENDINBLUE_APIKEY` — Sendinblue / Brevo API key (optional)
- `EMAIL_FROM` — default from email address
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — SMTP credentials for nodemailer
- `NOTIFICATIONS_QUEUE` — optional queue name (defaults to `NOTIFICATIONS`)

See the per-service `.env.example` files in each service folder for exact keys and suggested placeholders.

## Purge notifications queue

The script `notification-service/scripts/purgeQueue.js` will connect to RabbitMQ and purge the configured queue. Run it manually as:

```bash
cd notification-service
node scripts/purgeQueue.js
```

It checks `MESSAGE_BROKER_URL` and `NOTIFICATIONS_QUEUE` (defaults to `NOTIFICATIONS`).

## Docker / docker-compose

To be added soon

## Troubleshooting

- If a service can't connect to RabbitMQ: verify `MESSAGE_BROKER_URL` and broker availability.
- If MongoDB connections fail: verify `MONGO_URI` and database accessibility.
- Check each service's terminal logs for stack traces or error messages.
