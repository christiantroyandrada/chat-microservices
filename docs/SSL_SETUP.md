# SSL/HTTPS Setup Guide

This guide gives instructions to configure HTTPS with Let's Encrypt for the chat application.

## Prerequisites

1. **Domain pointing to your server**: The domain must have an A record that points to the VPS IP address. For example, use `yourdomain.com`.
2. **Port 80 and 443 open**: Both ports must be accessible from the internet.
3. **Docker running on VPS**: The application should already be deployed.

## Quick Setup

### Step 1: SSH into your VPS

```bash
ssh user@your-vps-ip
cd /opt/chat-app/chat-microservices
```

### Step 2: Configure your domain and email

Edit the script or set the environment variables:

```bash
export DOMAIN="yourdomain.com"
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

Add a cron job for automatic certificate renewal:

```bash
sudo crontab -e
```

Add this line:

The job renews certificates at 3 AM daily.
```
0 3 * * * /opt/chat-app/chat-microservices/scripts/renew-certs.sh >> /var/log/certbot-renew.log 2>&1
```

## What the Setup Does

The setup script does these actions:

1. It creates the `certbot/` directory for certificates.
2. It temporarily changes the nginx configuration to process ACME challenges, which verify domain control.
3. It runs certbot to obtain certificates.
4. It changes nginx to a configuration with SSL enabled.
5. It restarts nginx with HTTPS support.

## File Structure After Setup

```
chat-microservices/
├── certbot/
│   ├── conf/           # Let's Encrypt configuration and certificates
│   │   └── live/
│   │       └── yourdomain.com/
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

After setup, do a test of HTTPS:

```bash
# Test from anywhere
curl https://yourdomain.com/health

# Test locally on VPS
curl -k https://localhost/health
```

## Troubleshooting

### Certificate not obtained

1. Verify that port 80 is open and accessible.
2. Verify that DNS points to the server: `dig yourdomain.com`.
3. Do a check of the certbot logs: `cat certbot/logs/letsencrypt.log`.

<a id="nginx-wont-start-with-ssl"></a>
### Nginx does not start with SSL

1. Verify that certificates exist: `ls -la certbot/conf/live/yourdomain.com/`.
2. Do a check of the nginx configuration: `docker compose exec nginx nginx -t`.
3. Do a check of the nginx logs: `docker compose logs nginx`.

### Rate limits

Let's Encrypt has rate limits:
- 50 certificates per registered domain per week
- 5 duplicate certificates per week

Use `STAGING=1` for testing to prevent limit errors.

## Manual Certificate Renewal

```bash
cd /opt/chat-app/chat-microservices
./scripts/renew-certs.sh
```

## Reverting to HTTP-only

If you need to disable HTTPS, do these steps:

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

- Certificates are valid for 90 days.
- The renewal script does a daily check. When < 30 days remain, it renews certificates.
- HSTS is commented out by default. HSTS instructs browsers to use HTTPS.
- Only TLS 1.2/1.3 protocols are used.

After you confirm that SSL operates correctly, enable HSTS.
