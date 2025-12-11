# Server Health & Security Cron Jobs

This directory contains automated cron job scripts for maintaining server health and security.

## 📋 Cron Job Schedule

| Script | Schedule | Description |
|--------|----------|-------------|
| `health-check.sh` | Every 5 minutes | Monitors Docker services, auto-restarts unhealthy containers |
| `system-metrics.sh` | Every 10 minutes | Collects CPU, memory, disk, and container metrics |
| `intrusion-detect.sh` | Every 15 minutes | Monitors for brute force attacks and suspicious activity |
| `security-audit.sh` | Every hour (at :30) | Checks SSH attempts, firewall, open ports, privileges |
| `database-backup.sh` | Daily at 2 AM | Creates PostgreSQL backups with 7-day retention |
| `ssl-renew.sh` | Twice daily (3 AM & 3 PM) | Checks and renews Let's Encrypt SSL certificates |
| `log-rotate.sh` | Daily at 4 AM | Rotates and compresses application logs |
| `security-updates.sh` | Daily at 5 AM | Checks for security updates, triggers unattended upgrades |
| `docker-rebuild.sh` | Weekly (Saturday 2 AM) | Checks for base image updates, optionally rebuilds containers |
| `docker-cleanup.sh` | Weekly (Sunday 3 AM) | Removes unused Docker images, containers, build cache |
| `update-image-digests.sh` | Manual / CI | Updates SHA digests in Dockerfiles for security patches |

## 🔧 Installation

The cron jobs are installed on the VPS at `/opt/chat-app/scripts/cron/`.

To manually install or update the crontab:

```bash
ssh ubuntu@167.114.145.230 -p 49152

# View current crontab
crontab -l

# Edit crontab
crontab -e
```

## 📁 Log Files

All cron job logs are stored in `/var/log/chat-app/`:

- `health-check.log` - Health check results
- `security-audit.log` - Security audit results
- `security-alerts.log` - Security alerts (critical issues)
- `alerts.log` - General alerts
- `backup.log` - Database backup logs
- `ssl-renew.log` - SSL certificate renewal logs
- `docker-cleanup.log` - Docker cleanup logs
- `docker-rebuild.log` - Docker image rebuild logs
- `digest-update.log` - Image digest update logs
- `security-updates.log` - Security update check logs
- `intrusion-detect.log` - Intrusion detection logs
- `metrics/` - System metrics JSON files (daily)

## 🔒 Security Features

### UFW Firewall
- Default: Deny incoming, Allow outgoing
- Allowed ports: 49152 (SSH), 80 (HTTP), 443 (HTTPS)

### Fail2Ban
- Protects SSH on port 49152
- Bans IPs after 5 failed attempts for 1 hour

### Unattended Upgrades
- Automatic security patches enabled
- Daily package list updates
- Weekly auto-cleanup of old packages

## 📊 Status Check

Run the status script to see current server health:

```bash
ssh ubuntu@167.114.145.230 -p 49152 '/opt/chat-app/scripts/cron/status.sh'
```

## 🗄️ Backups

Database backups are stored at `/opt/chat-app/backups/postgres/`:
- Filename format: `chat_db_backup_YYYY-MM-DD_HH-MM-SS.sql.gz`
- Retention: 7 days
- Latest backup symlink: `latest.sql.gz`

### Restore from Backup

```bash
# SSH into server
ssh ubuntu@167.114.145.230 -p 49152

# Restore from latest backup
cd /opt/chat-app/backups/postgres
gunzip -c latest.sql.gz | docker exec -i chat-microservices-postgres-1 psql -U postgres chat_db
```

## ⚠️ Alerts

Security and health alerts are written to:
- `/var/log/chat-app/alerts.log` - General alerts
- `/var/log/chat-app/security-alerts.log` - Security-specific alerts

Monitor for alerts:
```bash
ssh ubuntu@167.114.145.230 -p 49152 'tail -f /var/log/chat-app/alerts.log'
```

## 🛠️ Maintenance

### Docker Image Security

The following scripts help maintain secure, up-to-date container images:

#### Check for Base Image Updates
```bash
# Check if base images have security updates available
/opt/chat-app/scripts/cron/docker-rebuild.sh
```

#### Auto-Rebuild with Updates (use with caution)
```bash
# Enable auto-rebuild (rebuilds images when updates are available)
AUTO_REBUILD=true /opt/chat-app/scripts/cron/docker-rebuild.sh

# Enable auto-rebuild AND auto-deploy (full automation)
AUTO_REBUILD=true AUTO_DEPLOY=true /opt/chat-app/scripts/cron/docker-rebuild.sh
```

#### Update Dockerfile SHA Digests
```bash
# Check if pinned image digests need updating (dry-run)
/opt/chat-app/scripts/cron/update-image-digests.sh

# Apply updates to Dockerfiles
/opt/chat-app/scripts/cron/update-image-digests.sh --apply
```

### Manual Script Execution

```bash
# Test health check
/opt/chat-app/scripts/cron/health-check.sh

# Manual database backup
/opt/chat-app/scripts/cron/database-backup.sh

# Manual security audit
/opt/chat-app/scripts/cron/security-audit.sh

# Check SSL certificate status
/opt/chat-app/scripts/cron/ssl-renew.sh

# Docker cleanup
/opt/chat-app/scripts/cron/docker-cleanup.sh
```

### View Blocked IPs

```bash
# View IPs blocked by fail2ban
sudo fail2ban-client status sshd

# View manually blocked IPs
cat /opt/chat-app/blocked-ips.txt
```

### Unblock an IP

```bash
sudo fail2ban-client set sshd unbanip <IP_ADDRESS>
```
