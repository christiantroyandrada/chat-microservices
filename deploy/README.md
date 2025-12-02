# Deployment Guide

This guide explains how to deploy the chat application stack using the new **image-based CI/CD pipeline**.

## 🚀 New Architecture (December 2024)

The deployment has been completely redesigned for security and efficiency:

### Key Changes
- ✅ **No git clone/pull on VPS** - Images are pre-built in GitHub Actions
- ✅ **GitHub Container Registry (GHCR)** - All images stored in GHCR
- ✅ **No source code on server** - Only docker-compose.yml and data volumes
- ✅ **Automatic security cleanup** - Source files removed after deployment
- ✅ **Secret masking** - All sensitive values masked in CI logs

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
- **NGINX**: Reverse proxy/API gateway (80/443)
- **PostgreSQL**: Database (5432)
- **pgAdmin**: Database management UI (8088, localhost only)

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

**Note**: `GITHUB_TOKEN` is automatically provided by GitHub Actions for GHCR authentication.

See [GITHUB_SECRETS.md](./GITHUB_SECRETS.md) for detailed setup.

### Infisical Secrets (Required)

Store these in your Infisical project (prod environment):

| Secret | Required | Default |
|--------|----------|---------|
| `ADMIN_USERNAME` | ✅ | - |
| `ADMIN_PASSWORD` | ✅ | - |
| `ADMIN_PASSWORD_ENCODED` | ✅ | - |
| `SMTP_HOST` | ⚠️ | `smtp-relay.brevo.com` |
| `SMTP_USER` | ⚠️ | - |
| `SMTP_PASS` | ⚠️ | - |
| `EMAIL_FROM` | ⚠️ | `admin@ctaprojects.xyz` |
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

Push to `main` branch to trigger the first deployment. The CI/CD will:
1. Build all Docker images
2. Push to GHCR
3. SSH to VPS and create docker-compose.yml
4. Pull images and start services

## Deployment Process

### Automatic Deployment (Recommended)

Simply push to the `main` (backend) or `master` (frontend) branch:

```bash
git push origin main
```

GitHub Actions will:
1. ✅ Run tests and security audits
2. ✅ Build Docker images in CI
3. ✅ Push images to GHCR
4. ✅ SSH to VPS and pull images
5. ✅ Start/restart services
6. ✅ Verify health checks
7. ✅ Clean up source files

### Manual Deployment (Emergency)

If you need to manually deploy:

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

### Check Service Status

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

## Troubleshooting

### Image Pull Failed

```bash
# Re-authenticate with GHCR
docker logout ghcr.io
echo "YOUR_GHCR_TOKEN" | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Pull again
docker compose pull
```

### Service Won't Start

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

1. Check nginx is running: `docker compose ps nginx`
2. Check frontend is healthy: `docker compose ps frontend`
3. Check nginx logs: `docker compose logs nginx --tail=50`
4. Verify frontend image tag in docker-compose.yml

## Security Considerations

### What's Protected

1. **No source code on VPS** - Only docker-compose.yml remains
2. **Secret masking in CI** - All passwords/tokens masked in logs
3. **Secure credential passing** - Here-strings instead of echo pipes
4. **Automatic cleanup** - .git, source directories removed after deploy
5. **GHCR authentication** - Token-based, not username/password

### Best Practices

1. **GITHUB_TOKEN is auto-rotated** - No manual rotation needed
2. **Use strong VPS_SUDO_PASSWORD**
3. **Enable UFW/firewall** - Only expose ports 80, 443, and SSH
4. **Configure SSL** with Let's Encrypt
5. **Monitor** for unauthorized access

## Rollback

To rollback to a previous version:

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
- [ ] Database backups automated
- [ ] Monitoring/alerting set up
- [ ] Strong passwords for all services

## Related Documentation

- [GitHub Secrets Guide](./GITHUB_SECRETS.md)
- [Infisical Setup Guide](./INFISICAL_SETUP.md)
- [Security Guide](../SECURITY.md)
