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

- 🔐 **End-to-End Encryption**: Signal Protocol (X3DH + Double Ratchet) with client-side key encryption
- 🔒 **Zero-Knowledge Architecture**: Stores encrypted key bundles only - server never sees plaintext keys
- 🛡️ **Security Hardening**: AES-256-GCM encryption, PBKDF2 (100k iterations), rate limiting, audit logging
- � **JWT Authentication**: Secure httpOnly cookie-based authentication
- ⚡ **Real-time Communication**: WebSocket support via Socket.IO
- 💾 **PostgreSQL Database**: Type-safe database queries with TypeORM
- 🐰 **RabbitMQ Messaging**: Inter-service communication via message queues
- 🐳 **Docker Support**: Full containerization with docker-compose
- � **Admin Tools**: pgAdmin web UI for database management
- � **Audit Logging**: Comprehensive logging of all key operations for security monitoring

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
- **Asset Storage**: Cloudinary for static assets and email images (external)
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
    ┌──────────────┐  ┌──────────────┐
    │  RabbitMQ    │  │  Cloudinary  │
    │  (CloudAMQP) │  │  (Assets)    │
    └──────────────┘  └──────────────┘
         ↑                   ↑
    MESSAGE_BROKER_URL   Static Assets
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
- `user`, `chat`, `notification` services (Node.js microservices with distroless runtime)
- `nginx` (reverse proxy, host port 80, vendor Bitnami image)

**Note**: RabbitMQ and SMTP are external services configured via environment variables.

### Environment-Aware Configuration

This project uses **environment-aware Docker configuration** that automatically selects the appropriate settings for local development vs production:

| Environment | nginx Config | SSL | NODE_ENV | Ports |
|-------------|--------------|-----|----------|-------|
| **Development** | `nginx.conf` (HTTP only) | ❌ No | development | 80, 443 (HTTP) |
| **Production** | `ssl/nginx-ssl.conf` (HTTPS) | ✅ Let's Encrypt | production | 80, 443 (HTTPS) |

**How it works:**

1. **nginx Dockerfile** accepts a build argument `NGINX_ENV` (default: `development`)
2. **Local development**: Uses default `development` config → HTTP-only nginx
3. **CI/CD production**: Passes `NGINX_ENV=production` → SSL-enabled nginx
4. **Production overlay**: `docker-compose.prod.yml` adds SSL volumes and production environment

**Usage:**

```bash
# Local development (HTTP only, no SSL required)
docker compose up -d --build

# Production build with SSL (requires Let's Encrypt certs)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Helper script with automatic environment detection
./scripts/docker-env.sh up -d --build

# Force production mode locally (for testing)
DEPLOY_ENV=production ./scripts/docker-env.sh up -d --build
```

**Environment Detection (docker-env.sh):**
- `GITHUB_ACTIONS=true` → Production mode
- `CI=true` → Production mode  
- `DEPLOY_ENV=production` → Production mode (explicit)
- SSL certs exist in `./certbot/conf` → Production mode
- Default → Development mode

### Container Images (Security Hardened)

All Node.js services use **multi-stage distroless builds** for security and minimal attack surface:

- **Builder stage**: Official Node.js 22 slim (pinned digest) — compiles TypeScript, installs deps
- **Runtime stage**: Google distroless nodejs22-debian12:nonroot — minimal runtime, no shell/package manager
- **Build hardening**: `npm ci`, `npm cache clean --force`, `npm prune --production`
- **Nginx**: Bitnami nginx (pinned digest) — vendor-maintained, zero vulnerabilities

**Security benefits**:
- Non-root execution in all containers
- Minimal attack surface (distroless = no shell, package manager, or unnecessary tools)
- Smaller image sizes (~50MB runtime vs ~200MB full Node)
- Reproducible builds via digest pinning
- Low vulnerability count (Nov 18, 2025: 12 LOW severity OS findings per service, 0 for nginx)

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
- Idempotent migrations with `hasTable()` checks
- `synchronize: true` in development for auto-sync
- `runMigrations()` in production for controlled schema changes

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

### Docker Desktop Bind Mount Issues (macOS)

**Problem**: After Docker Desktop updates (especially v4.52+), you may see errors like:
```
Error response from daemon: invalid mount config for type "bind": 
bind source path does not exist: /host_mnt/Users/.../docker-secrets/app_secrets
```

**Root Cause**: Docker Desktop's VM caches host path mappings. If your repository path previously contained spaces or was renamed, the VM may still try to resolve old cached paths for bind mounts.

**Solution**: This project now uses a **volume-based secrets approach** that avoids Docker Desktop's VM path translation entirely:
- The `setup` service copies secrets from the repository into a shared Docker volume
- All other services mount this volume read-only at `/run/secrets/app_secrets`
- No bind mounts = no VM path translation issues

**This approach is:**
- ✅ Reliable on Docker Desktop (any version, any path)
- ✅ Cloud/VPS ready (volumes work everywhere)
- ✅ Secure (volume permissions isolated to Docker)
- ✅ No manual workarounds or temp files needed

**If you still see bind mount errors:**
1. Ensure you're running the latest version of this repository's `docker-compose.yml`
2. Clean up old volumes: `docker-compose down -v`
3. Restart Docker Desktop
4. Bring up the stack fresh: `docker-compose up --build -d`

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

## 📋 Scope and Limitations

This project is an **advanced personal/side project** developed using an AI-assisted hybrid approach. While it demonstrates production-level architecture and security practices, it's important to understand its scope relative to enterprise messaging platforms.

### What This Project Demonstrates

✅ **Production-Ready Architecture**
- Microservices design with proper separation of concerns
- Secure container orchestration with Docker Compose
- CI/CD pipelines with GitHub Actions and GHCR
- Environment-aware builds (development vs production)
- Zero-downtime blue-green deployments with rollback capability

✅ **Security Implementation**
- End-to-End Encryption using Signal Protocol (X3DH + Double Ratchet)
- Zero-knowledge architecture (server never sees plaintext keys)
- AES-256-GCM encryption with PBKDF2 key derivation (100k iterations)
- JWT authentication with httpOnly cookies
- Rate limiting, input validation, and SQL injection protection
- Distroless containers with minimal attack surface

✅ **Real-Time Communication**
- WebSocket-based messaging via Socket.IO
- Message persistence with PostgreSQL
- Inter-service communication via RabbitMQ

✅ **AI-Assisted Development Value**
- Demonstrates effective human-AI collaboration
- Shows how AI can accelerate development while human maintains quality control
- Proves that a single developer + AI can build complex distributed systems

### Limitations Compared to Production Messaging Apps

| Feature | This Project | Messenger/Telegram/Signal |
|---------|--------------|---------------------------|
| **Message Types** | Text only | Text, images, videos, voice, files, stickers, GIFs |
| **Group Chats** | 1:1 conversations | Groups with 200K+ members, channels, communities |
| **Voice/Video** | ❌ Not implemented | Full VoIP, video calls, screen sharing |
| **Message Features** | Basic send/receive | Reactions, replies, forwards, edits, delete for everyone |
| **Media Handling** | Basic Cloudinary | Compression, thumbnails, streaming, CDN distribution |
| **Offline Support** | Limited | Full offline mode, message queuing, sync |
| **Push Notifications** | Basic | Rich notifications, badges, sounds, grouping |
| **Search** | ❌ Not implemented | Full-text search, filters, date ranges |
| **User Discovery** | Manual | Phone/username search, contact sync, QR codes |
| **Status/Stories** | ❌ Not implemented | 24hr stories, status updates |
| **Bots/Integrations** | ❌ Not implemented | Bot APIs, webhooks, third-party integrations |

### Infrastructure Limitations

| Aspect | This Project | Production-Scale (GCash/Telegram) |
|--------|--------------|-----------------------------------|
| **Deployment** | Single VPS (4 vCPU, 2GB RAM) | Multi-region, auto-scaling clusters |
| **Database** | Single PostgreSQL instance | Sharded databases, read replicas, caching layers |
| **Message Queue** | CloudAMQP free tier | Dedicated Kafka/RabbitMQ clusters |
| **CDN** | Cloudinary free tier | Global CDN with edge caching |
| **Monitoring** | Basic health checks | APM, distributed tracing, alerting |
| **Load Balancing** | Nginx on single node | Global load balancers, anycast |
| **Disaster Recovery** | Manual backups | Multi-region replication, automatic failover |
| **Compliance** | Best-effort security | SOC2, GDPR, PCI-DSS certified |

### Scalability Considerations

This project is designed for **demonstration and learning purposes**, not for production scale:

- **Concurrent Users**: Tested with < 100 concurrent connections
- **Message Volume**: Not optimized for millions of messages/day
- **Database**: Single instance without sharding or read replicas
- **WebSocket**: Single server, no horizontal scaling with sticky sessions
- **Storage**: Basic file storage without optimization for large media files

### What Would Be Needed for Production

To scale this to production level (like Telegram, Signal, or enterprise apps):

1. **Infrastructure**: Kubernetes with auto-scaling, multi-region deployment
2. **Database**: PostgreSQL with Citus or similar for horizontal scaling + Redis caching
3. **Message Queue**: Dedicated Kafka for high-throughput event streaming
4. **Media Pipeline**: Dedicated media processing (transcoding, thumbnails, CDN)
5. **Monitoring**: Prometheus + Grafana, distributed tracing (Jaeger), ELK stack
6. **Security Audit**: Professional penetration testing, compliance certification
7. **Team**: Dedicated DevOps, security engineers, mobile developers

### Honest Assessment

**This project is:**
- ✅ An excellent demonstration of modern microservices architecture
- ✅ A showcase of AI-assisted development capabilities
- ✅ A solid foundation for learning distributed systems
- ✅ Impressive for a personal/side project

**This project is NOT:**
- ❌ A replacement for established messaging platforms
- ❌ Ready for enterprise production deployment without significant investment
- ❌ Suitable for high-traffic commercial applications as-is

### Target Use Cases

This project is ideal for:
- 📚 Learning microservices architecture and E2EE implementation
- 🎯 Portfolio demonstration of full-stack development skills
- 🧪 Experimenting with modern DevOps practices
- 🏗️ Foundation for building a specialized chat application (internal team chat, niche community)

---

## Security

This project implements multiple security layers for local development and production readiness. See [SECURITY.md](./SECURITY.md) for detailed guidelines.

### Key Security Features

1. **Container Security**
   - All services run as non-root users
   - Admin UIs bound to localhost only (127.0.0.1)
   - **Distroless runtime images**: Multi-stage builds with minimal distroless runtime
   - **Pinned image digests**: Reproducible builds with digest-pinned base images
   - **Build hardening**: npm cache clean, production-only dependencies
   - **No shell/package manager**: Distroless images contain only Node.js + app code
   - **Vulnerability scan status** (Nov 18, 2025):
     - user/chat/notification services: 12 LOW severity findings (Debian OS packages)
     - nginx: 0 vulnerabilities (vendor-pinned Bitnami image)

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
- [x] Enable HTTPS/TLS (Let's Encrypt SSL configured)
- [ ] Set `NODE_ENV=production`
- [ ] Configure proper CORS origins
- [ ] Review rate limits for production traffic
- [ ] Enable `secure: true` for cookies
- [x] Verify distroless images are in use (check Dockerfiles)
- [x] TypeORM migrations created with idempotent checks
- [ ] Schedule regular image rebuilds for OS patches (weekly/monthly)
- [ ] Review and apply production recommendations in [SECURITY.md](./SECURITY.md)

For more details, see the [Security Guidelines](./SECURITY.md).

**Recent Security Improvements (November 2025)**: 
- **Container hardening**: Migrated to distroless runtime images with multi-stage builds
- **Database migration**: PostgreSQL with TypeORM for type-safe queries
- **Input validation**: express-validator on all endpoints
- **Enhanced rate limiting**: Global and auth-specific limits
- **Improved cookie security**: httpOnly, secure, sameSite flags

See [SECURITY_IMPROVEMENTS.md](./SECURITY_IMPROVEMENTS.md) for implementation details.
