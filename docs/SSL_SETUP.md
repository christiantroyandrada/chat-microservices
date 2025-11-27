# SSL/HTTPS Setup Guide

This guide explains how to set up HTTPS with Let's Encrypt for your chat application.

## Prerequisites

1. **Domain pointing to your server**: Your domain (e.g., `chat.ctaprojects.xyz`) must have an A record pointing to your VPS IP address
2. **Port 80 and 443 open**: Both ports must be accessible from the internet
3. **Docker running on VPS**: The application should already be deployed

## Quick Setup

### Step 1: SSH into your VPS

```bash
ssh user@your-vps-ip
cd /opt/chat-app/chat-microservices
```

### Step 2: Configure your domain and email

Edit the script or set environment variables:

```bash
export DOMAIN="chat.ctaprojects.xyz"
export EMAIL="your-email@example.com"
```

### Step 3: Run the SSL initialization script

```bash
# First, test with staging certificates (recommended)
STAGING=1 ./scripts/init-letsencrypt.sh

# If staging works, run again with production certificates
STAGING=0 ./scripts/init-letsencrypt.sh
```

### Step 4: Set up automatic renewal

Add a cron job to renew certificates automatically:

```bash
sudo crontab -e
```

Add this line (renews at 3 AM daily):
```
0 3 * * * /opt/chat-app/chat-microservices/scripts/renew-certs.sh >> /var/log/certbot-renew.log 2>&1
```

## What the Setup Does

1. Creates `certbot/` directory for certificates
2. Temporarily modifies nginx config to handle ACME challenges
3. Runs certbot to obtain certificates
4. Switches nginx to SSL-enabled configuration
5. Restarts nginx with HTTPS support

## File Structure After Setup

```
chat-microservices/
├── certbot/
│   ├── conf/           # Let's Encrypt configuration and certificates
│   │   └── live/
│   │       └── chat.ctaprojects.xyz/
│   │           ├── fullchain.pem
│   │           └── privkey.pem
│   ├── www/            # ACME challenge files
│   └── logs/           # Certbot logs
├── nginx/
│   ├── nginx.conf      # Active config (HTTP or HTTPS)
│   └── ssl/
│       └── nginx-ssl.conf  # SSL template
└── scripts/
    ├── init-letsencrypt.sh  # Initial setup
    └── renew-certs.sh       # Certificate renewal
```

## Testing HTTPS

After setup:

```bash
# Test from anywhere
curl https://chat.ctaprojects.xyz/health

# Test locally on VPS
curl -k https://localhost/health
```

## Troubleshooting

### Certificate not obtained

1. Check that port 80 is open and accessible
2. Verify DNS is pointing to your server: `dig chat.ctaprojects.xyz`
3. Check certbot logs: `cat certbot/logs/letsencrypt.log`

### Nginx won't start with SSL

1. Verify certificates exist: `ls -la certbot/conf/live/chat.ctaprojects.xyz/`
2. Check nginx config: `docker compose exec nginx nginx -t`
3. Check nginx logs: `docker compose logs nginx`

### Rate limits

Let's Encrypt has rate limits:
- 50 certificates per registered domain per week
- 5 duplicate certificates per week

Use `STAGING=1` for testing to avoid hitting limits.

## Manual Certificate Renewal

```bash
cd /opt/chat-app/chat-microservices
./scripts/renew-certs.sh
```

## Reverting to HTTP-only

If you need to disable HTTPS:

1. Copy the original nginx.conf back:
   ```bash
   git checkout nginx/nginx.conf
   ```
2. Rebuild nginx:
   ```bash
   docker compose build nginx
   docker compose up -d nginx
   ```

## Security Notes

- Certificates are valid for 90 days
- The renewal script checks daily and renews when < 30 days remain
- HSTS is commented out by default - enable after confirming SSL works
- Modern TLS 1.2/1.3 protocols only
