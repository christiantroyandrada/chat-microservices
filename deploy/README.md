# Deployment Guide

This guide gives instructions to deploy the chat application stack with the **image-based CI/CD pipeline**.

<a id="-new-architecture-december-2024"></a>
## New Architecture (December 2024)

This section records the deployment redesign from December 2024. The redesign improves security and efficiency.
This historical description does not give release approval.

### Key Changes
- **No git clone/pull on VPS**: GitHub Actions builds images before deployment.
- **GitHub Container Registry (GHCR)**: GHCR stores all images.
- **No source code on server**: The server contains only docker-compose.yml and data volumes.
- **Automatic security cleanup**: The pipeline removes source files after deployment.
- **Secret masking**: CI logs conceal all sensitive values.

### Deployment Flow
```
Push to main/master
       ↓
GitHub Actions: Build & Test
       ↓
GitHub Actions: Build Docker Images
       ↓
Push to GHCR (ghcr.io)
       ↓
SSH to VPS: Pull Images from GHCR
       ↓
Docker Compose: Start Services
       ↓
Security Cleanup: Remove source files
```

## Architecture

The deployment uses a Docker Compose stack with:
- **Backend Services**: User (8081), Chat (8082), Notification (8083) microservices
- **Frontend Service**: SvelteKit application (3000)
- **NGINX**: Reverse proxy/API gateway (80/443) with SSL termination
- **PostgreSQL**: Database (5432)
- **pgAdmin**: Database management UI (accessible at `/pgadmin/` via HTTPS)

## Prerequisites

### VPS Requirements
- Ubuntu 20.04+ or Debian 11+
- Minimum 2GB RAM, 2 CPU cores
- 20GB+ storage
- Docker and Docker Compose v2 installed
- SSH access with key-based authentication

### GitHub Secrets (Required)

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | VPS IP address or domain |
| `VPS_USER` | SSH user with Docker access |
| `VPS_SSH_PRIVATE_KEY` | SSH private key |
| `VPS_PORT` | SSH port (default: 22) |
| `VPS_SUDO_PASSWORD` | Sudo password for privileged ops |
| `INFISCAL_CLIENT_ID` | Infisical client ID |
| `INFISCAL_CLIENT_SECRET` | Infisical client secret |
| `INFISCAL_PROJECT_SLUG` | Infisical project slug |

GitHub Actions automatically provides `GITHUB_TOKEN` for GHCR authentication.

See [GITHUB_SECRETS.md](./GITHUB_SECRETS.md) for detailed setup.

### Infisical Secrets (Required)

Store these secrets in the prod environment of your Infisical project:

| Secret | Required | Default |
|--------|----------|---------|
| `ADMIN_USERNAME` | ✅ | - |
| `ADMIN_PASSWORD` | ✅ | - |
| `ADMIN_PASSWORD_ENCODED` | ✅ | - |
| `SMTP_HOST` | ⚠️ | `smtp-relay.brevo.com` |
| `SMTP_USER` | ⚠️ | - |
| `SMTP_PASS` | ⚠️ | - |
| `EMAIL_FROM` | ⚠️ | `admin@yourdomain.com` |
| `CORS_ORIGINS` | ⚠️ | - |
| `MESSAGE_BROKER_URL` | ⚠️ | - |
| `SENDINBLUE_APIKEY` | ⚠️ | - |

## Initial VPS Setup

### Step 1: Prepare Your VPS

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Create deploy user
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo usermod -aG sudo deploy

# Setup SSH for deploy user
sudo su - deploy
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# Add your public key
echo "YOUR_PUBLIC_KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Step 2: Create Deploy Directory

```bash
sudo mkdir -p /opt/chat-app
sudo chown deploy:deploy /opt/chat-app
```

### Step 3: First Deployment

Push to the `main` branch to start the first deployment.

The CI/CD pipeline does these actions:
1. It builds all Docker images.
2. It pushes the images to GHCR.
3. It connects to the VPS through SSH and creates docker-compose.yml.
4. It pulls images and starts services.

## Deployment Process

### Automatic Deployment (Recommended)

Push to the `main` (backend) or `master` (frontend) branch:

```bash
git push origin main
```

GitHub Actions does these actions:
1. It runs tests and security audits.
2. It builds Docker images in CI.
3. It pushes images to GHCR.
4. It connects to the VPS through SSH and pulls images.
5. It starts or restarts services.
6. It verifies health checks.
7. It removes source files.

### Manual Deployment (Emergency)

If you need a manual deployment, use these commands:

```bash
ssh deploy@YOUR_VPS -p YOUR_PORT
cd /opt/chat-app/chat-microservices

# Login to GHCR
echo "YOUR_GHCR_TOKEN" | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Pull latest images
docker compose pull

# Restart services
docker compose up -d --force-recreate
```

## Monitoring

<a id="check-service-status"></a>
### Service Status

```bash
cd /opt/chat-app/chat-microservices
docker compose ps
```

Expected output:
```
NAME          STATUS    PORTS
postgres      healthy   5432/tcp
pgadmin       running   127.0.0.1:8088->80/tcp
user          healthy   8081/tcp
chat          healthy   8082/tcp
notification  healthy   8083/tcp
frontend      healthy   3000/tcp
nginx         healthy   0.0.0.0:80->8080/tcp, 0.0.0.0:443->8443/tcp
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f frontend
docker compose logs -f user
docker compose logs -f notification
```

### Health Checks

```bash
# NGINX gateway
curl http://localhost:80/health

# Individual services (inside container network)
docker compose exec user wget -qO- http://localhost:8081/health
docker compose exec chat wget -qO- http://localhost:8082/health
docker compose exec notification wget -qO- http://localhost:8083/health
```

### Access pgAdmin (Database Management)

pgAdmin is accessible via the nginx reverse proxy at:
```
https://your-domain.com/pgadmin/
```

Log in with the credentials configured in your Infisical secrets:
- **Email**: Value of `PGADMIN_EMAIL`
- **Password**: Value of `ADMIN_PASSWORD`

To connect to the PostgreSQL database in pgAdmin, use these values:
- **Host**: `postgres` (Docker service name)
- **Port**: `5432`
- **Username**: Value of `ADMIN_USERNAME`
- **Password**: Value of `ADMIN_PASSWORD`
- **Database**: `chat_db`

pgAdmin gives access to database administration functions.

Use strong passwords.
Consider additional network restrictions for production environments.

## Troubleshooting

### Image Pull Failed

```bash
# Re-authenticate with GHCR
docker logout ghcr.io
echo "YOUR_GHCR_TOKEN" | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Pull again
docker compose pull
```

<a id="service-wont-start"></a>
### Service Does Not Start

```bash
# Check logs for specific service
docker compose logs user --tail=100

# Check resource usage
docker stats

# Restart specific service
docker compose restart user
```

### Database Connection Issues

```bash
# Check PostgreSQL is healthy
docker compose exec postgres pg_isready -U YOUR_USERNAME

# Check DATABASE_URL in service
docker compose exec user env | grep DATABASE_URL
```

### Frontend Not Accessible

1. Verify that nginx operates: `docker compose ps nginx`.
2. Verify that the frontend is healthy: `docker compose ps frontend`.
3. Do a check of nginx logs: `docker compose logs nginx --tail=50`.
4. Verify the frontend image tag in docker-compose.yml.

## Security Considerations

<a id="whats-protected"></a>
### Protected Items

1. **No source code on VPS**: Only docker-compose.yml remains.
2. **Secret masking in CI**: Logs conceal all passwords and tokens.
3. **Secure credential passing**: The pipeline uses here-strings instead of echo pipes.
4. **Automatic cleanup**: The pipeline removes .git and source directories after deployment.
5. **GHCR authentication**: Authentication uses tokens, not usernames and passwords.

### Best Practices

GITHUB_TOKEN rotates automatically. Manual rotation is unnecessary.

1. Use a strong VPS_SUDO_PASSWORD.
2. Enable UFW/firewall.
3. Expose only ports 80, 443, and SSH.
4. Configure SSL with Let's Encrypt.
5. Monitor for unauthorized access.

## Rollback

To return to a previous version, use these commands:

```bash
ssh deploy@YOUR_VPS -p YOUR_PORT
cd /opt/chat-app/chat-microservices

# Edit docker-compose.yml to use previous image tag
# e.g., change :latest to :abc123def (previous commit SHA)
nano docker-compose.yml

# Pull specific version
docker compose pull

# Restart
docker compose up -d --force-recreate
```

## Production Checklist

- [ ] SSL/TLS certificates configured (Let's Encrypt)
- [ ] UFW firewall enabled (ports 80, 443, SSH only)
- [ ] VPS_SUDO_PASSWORD added to both repos
- [ ] VPS connection secrets configured (HOST, USER, SSH_KEY, PORT)
- [ ] Infisical secrets configured (especially SMTP_HOST, EMAIL_FROM)
- [ ] PGADMIN_EMAIL configured for database management access
- [ ] Database backups automated
- [ ] Monitoring/alerting set up
- [ ] Strong passwords for all services

## Database Migrations

All services use TypeORM migrations. The migrations run automatically at startup:

- **Idempotent migrations**: Migrations use `hasTable()` to skip tables that already exist. Repeated execution does not create duplicate tables.
- **Production safety**: The `typeorm_migrations` table tracks migrations.
- **Development mode**: The services use `synchronize: true` to synchronize the schema automatically during development.
- **Migration files**: The files are in `*/src/database/migrations/`.

Migrations run in this order:
1. `user-service` creates the `users` and `prekeys` tables.
2. `chat-service` creates the `messages` table with a status enum.
3. `notification-service` creates the `notifications` table with a type enum.

To do a check of migration status manually, use these commands:
```bash
docker compose exec user sh -c "ls -la /app/build/database/migrations/"
docker compose logs user | grep -i migration
```

## Related Documentation

- [GitHub Secrets Guide](./GITHUB_SECRETS.md)
- [Infisical Setup Guide](./INFISICAL_SETUP.md)
- [Security Guide](../SECURITY.md)
