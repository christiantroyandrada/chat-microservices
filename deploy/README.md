# Deployment Guide

This guide explains how to deploy the chat application stack to a VPS using GitHub Actions.

## Architecture

The deployment uses a Docker Compose stack with:
- **Backend Services**: User, Chat, and Notification microservices
- **Frontend Service**: SvelteKit application
- **NGINX**: Reverse proxy/API gateway
- **PostgreSQL**: Database
- **pgAdmin**: Database management UI

## Prerequisites

### VPS Requirements
- Ubuntu 20.04+ or Debian 11+
- Minimum 2GB RAM, 2 CPU cores
- 20GB+ storage
- Docker and Docker Compose installed
- Git installed
- SSH access with key-based authentication

### GitHub Secrets

Configure the following secrets in your GitHub repository:

#### Required Secrets
1. **VPS_HOST** - Your VPS IP address or domain name
2. **VPS_USER** - SSH user with Docker permissions (e.g., `deploy`)
3. **VPS_SSH_PRIVATE_KEY** - Private SSH key for authentication
4. **INFISICAL_CLIENT_ID** - Infisical machine identity client ID
5. **INFISICAL_CLIENT_SECRET** - Infisical machine identity client secret
6. **INFISICAL_PROJECT_ID** - Your Infisical project ID

#### Optional Secrets
7. **VPS_PORT** - SSH port (optional, defaults to 22)
8. **DEPLOY_PATH** - Deployment directory (optional, defaults to `/opt/chat-app`)
9. **INFISICAL_ENVIRONMENT** - Infisical environment (optional, defaults to `prod`)
10. **INFISICAL_SECRET_PATH** - Path in Infisical (optional, defaults to `/`)
11. **PGADMIN_EMAIL** - pgAdmin login email

### Infisical Setup

This project uses Infisical for centralized secret management. See the [Infisical Setup Guide](./INFISICAL_SETUP.md) for detailed instructions.

**Secrets managed by Infisical:**
- Database credentials (ADMIN_USERNAME, ADMIN_PASSWORD)
- SMTP configuration (SMTP_USER, SMTP_PASS)
- API keys (SENDINBLUE_APIKEY)
- Application config (CORS_ORIGINS, MESSAGE_BROKER_URL)

### How to Set Up GitHub Secrets

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add each secret with its value

## Initial VPS Setup

### Step 1: Prepare Your VPS

SSH into your VPS and run:

```bash
# Create deployment user
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG sudo deploy

# Generate SSH key for GitHub Actions
sudo su - deploy
ssh-keygen -t ed25519 -C "github-actions@deploy"

# Copy the private key content to GitHub secrets as VPS_SSH_PRIVATE_KEY
cat ~/.ssh/id_ed25519

# Add the public key to authorized_keys
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Step 2: Run Setup Script

Copy and run the setup script on your VPS:

```bash
# Download and run setup script
curl -o setup-vps.sh https://raw.githubusercontent.com/christiantroyandrada/chat-user-microservice/main/deploy/setup-vps.sh
chmod +x setup-vps.sh
./setup-vps.sh
```

Or manually:

```bash
# Set deployment path
export DEPLOY_PATH="/opt/chat-app"
export DEPLOY_USER="deploy"

# Create directory
sudo mkdir -p "$DEPLOY_PATH"
sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"

# Clone repositories
cd "$DEPLOY_PATH"
git clone https://github.com/christiantroyandrada/chat-user-microservice.git chat-microservices
git clone https://github.com/christiantroyandrada/chat-microservices-frontend.git chat-microservices-frontend
```

### Step 3: Configure Secrets

Copy your `app_secrets` file to the VPS:

```bash
# From your local machine
scp chat-microservices/docker-secrets/app_secrets deploy@YOUR_VPS_IP:/opt/chat-app/chat-microservices/docker-secrets/
```

Or create it directly on the VPS:

```bash
ssh deploy@YOUR_VPS_IP
cd /opt/chat-app/chat-microservices/docker-secrets
cp app_secrets.example app_secrets
nano app_secrets  # Edit with your actual secrets
chmod 600 app_secrets
```

### Step 4: Configure Environment Variables

On your VPS, set environment variables in your shell profile:

```bash
echo 'export ADMIN_USERNAME="your_db_user"' >> ~/.bashrc
echo 'export ADMIN_PASSWORD="your_secure_password"' >> ~/.bashrc
echo 'export PGADMIN_EMAIL="admin@example.com"' >> ~/.bashrc
source ~/.bashrc
```

Or create a `.env` file in `/opt/chat-app/chat-microservices/`:

```bash
cd /opt/chat-app/chat-microservices
cat > .env << 'ENVEOF'
ADMIN_USERNAME=your_db_user
ADMIN_PASSWORD=your_secure_password
PGADMIN_EMAIL=admin@example.com
ENVEOF
```

## Deployment Process

### Automatic Deployment (via GitHub Actions)

1. Push changes to the `main` branch
2. GitHub Actions will:
   - Run tests and security audits
   - Build Docker images
   - Deploy to VPS via SSH
   - Verify all services are healthy

### Manual Deployment

SSH into your VPS and run:

```bash
cd /opt/chat-app/chat-microservices
bash deploy/deploy-vps.sh
```

## Monitoring

### Check Service Status

```bash
cd /opt/chat-app/chat-microservices
docker compose ps
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f frontend
docker compose logs -f user
docker compose logs -f chat
docker compose logs -f notification
docker compose logs -f nginx
```

### Health Checks

```bash
# Check nginx gateway
curl http://localhost:85/health

# Check individual services (from within VPS)
docker compose exec user curl http://localhost:8081/health
docker compose exec chat curl http://localhost:8082/health
docker compose exec notification curl http://localhost:8083/health
```

## Troubleshooting

### Services Won't Start

```bash
# Check logs
docker compose logs --tail=100

# Check Docker resources
docker system df
docker system prune  # Clean up if needed

# Restart services
docker compose down
docker compose up -d
```

### Deployment Failed

1. Check GitHub Actions logs for errors
2. Verify SSH credentials and connectivity
3. Check VPS disk space: `df -h`
4. Check Docker status: `systemctl status docker`
5. Review service logs on VPS

### Database Issues

```bash
# Connect to PostgreSQL
docker compose exec postgres psql -U $ADMIN_USERNAME -d chat_db

# Check database size
docker compose exec postgres psql -U $ADMIN_USERNAME -c "\l+"

# Backup database
docker compose exec postgres pg_dump -U $ADMIN_USERNAME chat_db > backup.sql
```

## Security Considerations

1. **Firewall Configuration**: Only expose port 85 (or your chosen port) for the application
2. **SSL/TLS**: Configure NGINX with SSL certificates (Let's Encrypt recommended)
3. **Secret Management**: Never commit secrets to Git
4. **SSH Keys**: Use strong SSH keys and disable password authentication
5. **Database**: Change default passwords and restrict access
6. **Updates**: Regularly update Docker images and system packages

## Rollback

If deployment fails, rollback to the previous version:

```bash
cd /opt/chat-app/chat-microservices
git log --oneline -5  # Find previous commit
git reset --hard <commit-hash>
bash deploy/deploy-vps.sh
```

## Production Checklist

- [ ] SSL/TLS certificates configured
- [ ] Firewall configured (UFW or iptables)
- [ ] Database backups automated
- [ ] Monitoring and alerting set up
- [ ] Log rotation configured
- [ ] Strong passwords for all services
- [ ] app_secrets file secured (chmod 600)
- [ ] NODE_ENV=production in docker-compose.yml
- [ ] Regular security updates scheduled
- [ ] Disaster recovery plan documented

## Support

For issues or questions:
- Check GitHub Issues
- Review service logs
- Contact repository maintainers
