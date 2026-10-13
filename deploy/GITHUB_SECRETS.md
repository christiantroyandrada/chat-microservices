# GitHub Secrets Configuration

This document lists the secrets necessary for image-based CI/CD deployment.
CI/CD means continuous integration and continuous delivery.

## 🚀 New Deployment Architecture

The documented image-based deployment has these stages:

1. GitHub Actions creates Docker images in the CI pipeline.
2. The pipeline uploads images to GitHub Container Registry (GHCR).
3. The VPS downloads pre-built images. The server does not use git clone/pull.
4. The VPS does not store source code for security.

## How to Add Secrets

1. Open your GitHub repository.
2. Select **Settings** → **Secrets and variables** → **Actions**.
3. Select **New repository secret**.
4. Enter the name and value. Then select **Add secret**.

---

## Required GitHub Secrets

### VPS Connection Secrets

| Secret | Description | Required | Example |
|--------|-------------|----------|---------|
| `VPS_HOST` | IP address or domain of your VPS | ✅ Yes | `192.168.1.100` |
| `VPS_USER` | SSH username with Docker permissions | ✅ Yes | `deploy` |
| `VPS_SSH_PRIVATE_KEY` | Private SSH key for authentication | ✅ Yes | See below |
| `VPS_PORT` | SSH port number | ❌ No | `22` (default) |
| `VPS_SUDO_PASSWORD` | Sudo password for privileged operations | ✅ Yes | Your sudo password |

### GitHub Container Registry

The workflow uses the built-in `GITHUB_TOKEN` for GHCR authentication.
No manual setup is necessary.

GitHub Actions creates `GITHUB_TOKEN` automatically for each workflow run.
The workflow has `permissions: packages: write`.
This permission lets the token upload images to GHCR.

### Infisical Secrets (Production Secret Management)

| Secret | Description | Required |
|--------|-------------|----------|
| `INFISCAL_CLIENT_ID` | Infisical machine identity client ID | ✅ Yes |
| `INFISCAL_CLIENT_SECRET` | Infisical machine identity client secret | ✅ Yes |
| `INFISCAL_PROJECT_SLUG` | Your Infisical project slug | ✅ Yes |

The spelling `INFISCAL_*` is intentional. It matches the existing configuration.

### Optional Secrets

| Secret | Description | Default |
|--------|-------------|---------|
| `PGADMIN_EMAIL` | pgAdmin login email | `admin@admin.com` |

---

## Secrets Managed by Infisical

Infisical stores these secrets. The deployment downloads them:

### Database Credentials
| Secret | Description | Validated |
|--------|-------------|-----------|
| `ADMIN_USERNAME` | PostgreSQL admin username | ✅ Required |
| `ADMIN_PASSWORD` | PostgreSQL admin password | ✅ Required |
| `ADMIN_PASSWORD_ENCODED` | URL-encoded password for connection strings | ✅ Required |

### Email/SMTP Configuration
| Secret | Description | Default |
|--------|-------------|---------|
| `SMTP_HOST` | SMTP server hostname | `smtp-relay.brevo.com` |
| `SMTP_USER` | SMTP username | ⚠️ Warned if missing |
| `SMTP_PASS` | SMTP password | ⚠️ Warned if missing |
| `EMAIL_FROM` | Sender email address | `admin@yourdomain.com` |
| `SENDINBLUE_APIKEY` | SendinBlue/Brevo API key | ⚠️ Warned if missing |

### Application Configuration
| Secret | Description |
|--------|-------------|
| `CORS_ORIGINS` | Allowed CORS origins |
| `MESSAGE_BROKER_URL` | RabbitMQ connection URL |
| `PUBLIC_API_URL` | Frontend API URL (for Docker build) |
| `PUBLIC_WS_URL` | Frontend WebSocket URL (for Docker build) |

---

## SSH Key Setup

### Generate SSH Key

CAUTION: Do not put a private SSH key in `GITHUB_TOKEN`.
The secret table identifies `VPS_SSH_PRIVATE_KEY` for SSH authentication.
The preserved example contains an inconsistent comment.
```bash
# On your local machine or VPS
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_deploy

# Display private key (copy to GITHUB_TOKEN secret)
cat ~/.ssh/github_deploy

# Add public key to VPS authorized_keys
ssh-copy-id -i ~/.ssh/github_deploy.pub deploy@YOUR_VPS_IP
```

### Private Key Format
Copy the complete private key, including its headers.
The example below shows the required format:
```
-----BEGIN OPENSSH PRIVATE KEY-----
[key content]
-----END OPENSSH PRIVATE KEY-----
```

---

## Repository-Specific Secrets

### Backend Repository (`chat-user-microservice`)
- `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `VPS_PORT`
- `VPS_SUDO_PASSWORD`
- `INFISCAL_CLIENT_ID`, `INFISCAL_CLIENT_SECRET`, `INFISCAL_PROJECT_SLUG`
- `PGADMIN_EMAIL` (optional)
- `GITHUB_TOKEN` *(automatic - no setup needed)*

### Frontend Repository (`chat-microservices-frontend`)
- `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `VPS_PORT`
- `VPS_SUDO_PASSWORD`
- `INFISCAL_CLIENT_ID`, `INFISCAL_CLIENT_SECRET`, `INFISCAL_PROJECT_SLUG`
- `GITHUB_TOKEN` *(automatic - no setup needed)*

---

## Security Features

### Secret Masking
GitHub Actions logs use `::add-mask::` to hide these sensitive values:
- Passwords (ADMIN_PASSWORD, VPS_SUDO_PASSWORD)
- API keys (SENDINBLUE_APIKEY, GITHUB_TOKEN)
- Encoded credentials (ADMIN_PASSWORD_ENCODED)

### Secure Credential Passing
- The workflow passes sudo passwords through here-strings (`<<<`), not echo pipes.
- Docker login uses `--password-stdin` with here-strings.
- The workflow redirects stderr to `/dev/null` to prevent accidental leaks.

### Post-Deployment Cleanup
After deployment, the documented CI/CD pipeline automatically does these operations:

- It removes `.git` and `.github` directories.
- It removes source code directories.
- It removes unused Docker images and containers.

---

## Troubleshooting

### SSH Connection Failed
```bash
# Test SSH connection manually
ssh -i ~/.ssh/github_deploy -p YOUR_SSH_PORT deploy@YOUR_VPS_IP echo "Connected!"
```

### GHCR Authentication Failed
```bash
# Test GHCR login
echo "YOUR_GHCR_TOKEN" | docker login ghcr.io -u YOUR_USERNAME --password-stdin
```

### Missing Infisical Secrets
Examine the GitHub Actions log for validation output:
```
✅ ADMIN_USERNAME
✅ ADMIN_PASSWORD
⚠️ SMTP_HOST missing (defaulting to smtp-relay.brevo.com)
```

---

## Related Documentation

- [Deployment Guide](./README.md)
- [Infisical Setup Guide](./INFISICAL_SETUP.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
