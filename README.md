# Chat Microservices

A modern, secure chat system built with Node.js, TypeScript, PostgreSQL, and real-time WebSocket communication. This repository contains microservices for user authentication, real-time messaging with end-to-end encryption (E2EE), and notifications.

## 🤖 Development Philosophy

This project follows a **hybrid AI-assisted development approach** where human expertise and AI capabilities work together:

### Division of Labor

**👨‍💻 Developer's Primary Role:**
- **System Architecture Design**: Designing the overall system architecture, microservices structure, and technology stack decisions
- **Code Review & Guidance**: Reviewing AI-generated code for correctness, security, and adherence to best practices
- **Strategic Direction**: Defining project requirements, features, and technical direction
- **Quality Assurance**: Ensuring code meets production standards and business requirements

**🤖 AI's Primary Role:**
- **Code Scaffolding**: Generating boilerplate code, project structures, and initial implementations
- **Code Integration**: Integrating libraries, frameworks, and third-party services
- **Local Deployment**: Setting up Docker environments, configuration files, and deployment scripts
- **Troubleshooting**: Debugging issues, analyzing logs, and implementing fixes
- **Documentation**: Creating and maintaining comprehensive documentation

### Best Practices Guidance

The AI tool is guided by the developer to follow:
- Industry-standard coding patterns and practices
- Security-first development principles
- TypeScript type safety and strict mode
- Comprehensive error handling and logging
- Docker containerization and orchestration
- Automated testing and CI/CD pipelines

This collaborative approach combines the **strategic thinking and domain expertise of human developers** with the **rapid scaffolding and implementation capabilities of AI**, resulting in faster development cycles while maintaining high code quality and security standards.

## ✨ Key Features

- 🔐 **End-to-End Encryption**: Signal Protocol implementation for secure messaging
- 🔒 **JWT Authentication**: Secure httpOnly cookie-based authentication
- ⚡ **Real-time Communication**: WebSocket support via Socket.IO
- 💾 **PostgreSQL Database**: Type-safe database queries with TypeORM
- 🐰 **RabbitMQ Messaging**: Inter-service communication via message queues
- 🐳 **Docker Support**: Full containerization with docker-compose
- 🛡️ **Security First**: Helmet.js, rate limiting, input validation, CSRF protection
- 📊 **Admin Tools**: pgAdmin web UI for database management

## Repository Layout

- `user-service/` — Authentication and user management (port 8081)
- `chat-service/` — Real-time messaging with Socket.IO support (port 8082)
- `notification-service/` — Email and push notifications (port 8083)
- `nginx/` — Reverse proxy for all services (host port 85)
- `docker-compose.yml` — Orchestrates PostgreSQL, pgAdmin, all microservices, and nginx
- `scripts/` — Helper scripts including `generate-envs.sh` for automatic .env generation
- `docker-secrets/` — Consolidated secrets file (gitignored) and example template
- `k8s/` — Kubernetes deployment configurations (optional)
- `gateway/` — Standalone HTTP gateway (not used in docker-compose, development only)

## Architecture Overview

- **Database**: PostgreSQL 17.6 with TypeORM (shared by all services)
- **Message Queue**: RabbitMQ for inter-service communication (external)
- **Reverse Proxy**: Nginx on port 85 routes requests to appropriate services
- **API Routes**:
  - `/api/user/*` → user-service (port 8081)
  - `/api/chat/*` → chat-service (port 8082)
  - `/api/notifications/*` → notification-service (port 8083)

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Docker Compose Stack                                      │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │  setup   │→ │  postgres    │  │  pgadmin          │   │
│  │ (one-run)│  │  :5432       │  │  localhost:8088   │   │
│  └──────────┘  └──────────────┘  └───────────────────┘   │
│                       ↓                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ user-service │  │ chat-service │  │ notification    │ │
│  │   :8081      │  │   :8082      │  │   service       │ │
│  │              │  │ + Socket.IO  │  │   :8083         │ │
│  └──────────────┘  └──────────────┘  └─────────────────┘ │
│         ↓                  ↓                  ↓            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │           nginx (reverse proxy)                      │ │
│  │           localhost:85                               │ │
│  └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘

    External Services (not in compose):
    ┌──────────────┐
    │  RabbitMQ    │  ← MESSAGE_BROKER_URL
    │  (CloudAMQP) │
    └──────────────┘
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

This project supports two patterns for managing secrets locally:

1. Simple `.env` files (used by the services via dotenv) — good for quick local development.
2. A consolidated Docker secret file `docker-secrets/app_secrets` (recommended for local runs with `docker-compose`).

**What's included:**
- `docker-secrets/app_secrets.example` — a tracked example file you can commit. Copy it to `docker-secrets/app_secrets` and fill in real values locally.
- `.gitignore` excludes the `docker-secrets/` folder and `.env` files to avoid accidentally committing real secrets.

**How to use the consolidated secret file:**

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
- ✅ **JWT secrets auto-generated** if missing or weak (< 32 chars or default values)

**Automatic JWT Secret Generation**: The setup script detects weak or missing JWT secrets and automatically generates cryptographically secure 64-byte random values. Weak secrets include:
- Empty or missing values
- Default placeholders: `{{YOUR_SECRET_KEY}}`, `CHANGEME`, `changeme`, `test`, `secret`
- Any secret shorter than 32 characters

This ensures production deployments never use weak secrets accidentally.

**To manually regenerate `.env` files** (useful for local development):

```bash
./scripts/generate-envs.sh         # Creates .env files if they don't exist
./scripts/generate-envs.sh --force # Overwrites existing .env files
```

Both commands will check and auto-generate strong JWT secrets if needed.

## Secrets Guidance (CI / Production)

**Do not commit real secrets.** For CI and production environments, inject secrets via your CI provider or secret store (GitHub Actions Secrets, HashiCorp Vault, etc.). 

The tracked `docker-secrets/app_secrets.example` file uses `${VAR_NAME}` template placeholders to indicate which environment variables need to be set (for example, `${JWT_SECRET_NOTIFICATION}`).

When deploying locally with `docker-compose`, copy the example file to `docker-secrets/app_secrets` and replace the `${VAR_NAME}` placeholders with actual values on your machine. The repository's `.gitignore` prevents committing the real `app_secrets` file.

## Docker / docker-compose (Local Development)

The compose file brings up the following services:
- `setup` — One-time service that generates `.env` files from consolidated secrets
- `postgres` (postgres:17.6-trixie) — PostgreSQL database for all services
- `pgadmin` (dpage/pgadmin4, web UI, host port 8088) — PostgreSQL admin interface
- `user`, `chat`, `notification` services (Node.js microservices)
- `nginx` (reverse proxy, host port 85)

**Note**: RabbitMQ and SMTP are external services configured via environment variables.

### Basic Commands

Start all services (rebuild images):

```bash
docker-compose up -d --build
```

Recreate a single service without affecting others:

```bash
# Example: recreate user service only
docker-compose up -d --no-deps --force-recreate user
```

Check status and logs:

```bash
docker-compose ps
docker-compose logs -f user
docker-compose logs -f chat
docker-compose logs -f notification
docker-compose logs -f postgres
```

pgAdmin web interface is available at http://localhost:8088/ — a powerful PostgreSQL administration and management tool with query editor, schema browser, and performance monitoring.

**Note**: On first run, you'll need to add a server connection in pgAdmin:
- Host: `postgres` (Docker service name)
- Port: `5432`
- Username: Value from `ADMIN_USERNAME` in `.env`
- Password: Value from `ADMIN_PASSWORD` in `.env`
- Database: `chat_db`

## Healthchecks

All services include comprehensive health checks:
- `postgres` — Runs `pg_isready` to verify database availability
- `pgadmin` — HTTP ping check on the web UI
- `user`, `chat`, `notification` — HTTP `/health` endpoints checked by Docker
- `nginx` — Curl check on proxy health

## Security & Recent Enhancements (November 2025)

The project has undergone comprehensive security audits and major enhancements. For complete details, see `SECURITY.md`.

### Major Improvements:

✅ **Database Migration**: MongoDB → PostgreSQL with TypeORM
- Type-safe queries with parameterized SQL
- Connection pooling and query monitoring
- Database indexes for optimal performance
- `synchronize: false` in production for schema safety

✅ **End-to-End Encryption**: Signal Protocol implementation
- Client-side encryption/decryption
- Prekey bundle management
- Session establishment for secure messaging

✅ **Authentication & Authorization**:
- JWT-based authentication with httpOnly cookies
- Socket.IO authentication middleware
- Sender validation on all messages
- bcrypt password hashing (cost factor 12)

✅ **Security Hardening**:
- Input validation with express-validator
- Helmet.js security headers
- Global and auth-specific rate limiting
- CORS with explicit origins
- SQL injection protection via TypeORM
- WebSocket message size limits

✅ **CI/CD Security**:
- Automated npm security audits
- Container image scanning with Trivy
- TypeScript type checking
- Weekly scheduled security scans

Production deployment checklist and additional recommendations are in `SECURITY.md`.

## How to Run Services (Development Without Docker)

For quick local development of an individual service (example: `user-service`):

```bash
cd user-service
cp .env.example .env  # or run ../scripts/generate-envs.sh from repo root
npm install
npm run dev
```

Repeat for `chat-service` and `notification-service` when working on them individually.

**Note**: Services require PostgreSQL and RabbitMQ to be accessible. Configure `DATABASE_URL` and `MESSAGE_BROKER_URL` in your `.env` files.

## Helper Scripts

### Generate Environment Files

Automatically generate `.env` files from consolidated secrets:

```bash
./scripts/generate-envs.sh         # Creates .env files if they don't exist
./scripts/generate-envs.sh --force # Overwrites existing .env files
```

The script also auto-generates strong JWT secrets if missing or weak.

### Purge Notification Queue

Clear the RabbitMQ notification queue:

```bash
cd notification-service
node scripts/purgeQueue.js
```

Useful for clearing test messages during development.

## Troubleshooting

### PostgreSQL Connection Issues

If services fail to connect to PostgreSQL:
1. Verify `DATABASE_URL` in `.env` files or `docker-secrets/app_secrets`
2. Check PostgreSQL is running: `docker-compose ps postgres`
3. Verify credentials match between services and database
4. Check PostgreSQL logs: `docker-compose logs postgres`

### Verify pgAdmin Connectivity

```bash
curl -I http://localhost:8088/ || true
# Expected: HTTP/1.1 200 OK (pgAdmin UI is up)
```

Alternatively, open http://localhost:8088/ in your browser to access the pgAdmin interface.

### General Debugging

- Check service health: `docker-compose ps`
- View logs: `docker-compose logs --tail 200 <service>`
- Restart a service: `docker-compose restart <service>`
- Verify `.env` files were generated: `ls -la *-service/.env`
- Access PostgreSQL directly: `docker-compose exec postgres psql -U admin -d chat_db`

### Services Not Connecting to RabbitMQ

If services cannot connect to RabbitMQ:
- Verify `MESSAGE_BROKER_URL` in your consolidated secrets or `.env` files
- Check that RabbitMQ is accessible (if using CloudAMQP or local instance)
- Review service logs: `docker-compose logs -f user chat notification`

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
   - Vulnerable packages removed (replaced `sib-api-v3-typescript` with `axios`)

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

**Recent Security Improvements (November 2025)**: Input validation, MongoDB injection protection, environment validation, enhanced rate limiting, and improved cookie security. See [SECURITY_IMPROVEMENTS.md](./SECURITY_IMPROVEMENTS.md) for implementation details.
