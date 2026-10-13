# Infisical Integration Setup Guide

This guide describes Infisical secret management for the CI/CD pipeline.
CI/CD means continuous integration and continuous delivery.
The design claims below are source documentation, not new verification results.

## Architecture

```
GitHub Actions
    ↓
Infisical API (fetch secrets)
    ↓
Environment Variables
    ↓
SSH to VPS → Deploy with secrets
```

The original design lists these benefits:

- Secret management has one central location.
- The VPS does not store secrets.
- Each deployment gets current secrets.
- Operators can rotate and update secrets.
- Infisical keeps an audit record.

## Step 1: Create Infisical Project

1. If you have no account, register at [Infisical](https://infisical.com/).
2. Create a new project for your chat application.
3. Record your **Project ID** from the project settings.

## Step 2: Add Secrets to Infisical

In your Infisical project, add these secrets to the production environment:

### Database Secrets (Required)
```
ADMIN_USERNAME=postgres
ADMIN_PASSWORD=YourSecurePassword123!
ADMIN_PASSWORD_ENCODED=YourSecurePassword123%21
```

### SMTP/Email Secrets (Required for Email Features)
```
SMTP_HOST=smtp-relay.brevo.com
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
EMAIL_FROM=noreply@yourdomain.com
SENDINBLUE_APIKEY=your-sendinblue-api-key
```

If `SMTP_HOST` or `EMAIL_FROM` is not configured, CI/CD uses these defaults:
- `SMTP_HOST` defaults to `smtp-relay.brevo.com`
- `EMAIL_FROM` defaults to `admin@yourdomain.com`

### Application Secrets (Recommended)
```
CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com
MESSAGE_BROKER_URL=amqp://username:password@rabbitmq:5672
```

## Step 3: Create Machine Identity

Machine identities let GitHub Actions authenticate with Infisical.
Create the identity with these steps:

1. In Infisical, select **Access Control** → **Machine Identities**.
2. Select **Create Machine Identity**.
3. Set the name to `github-actions-deploy`.
4. Set the description to `Machine identity for GitHub Actions CI/CD`.
5. Select **Create**.
6. Copy the **Client ID** and **Client Secret**. The interface shows them only once.

## Step 4: Grant Access to Machine Identity

1. Open your project settings.
2. Select **Access Control** → **Machine Identities**.
3. Find `github-actions-deploy`. Then select **Add to Project**.
4. Select the `production` environment (or your environment name).
5. Set the permissions to **Read**, the minimum necessary permission.
6. Set the path to `/` (or the path that contains your secrets).

## Step 5: Add Secrets to GitHub

Add these secrets to both repositories:

### Required GitHub Secrets

The workflow uses `INFISCAL_*` (without 'I') to match the existing configuration.

1. **INFISCAL_CLIENT_ID**
   - Value: Client ID from Step 3
   - Location: Settings → Secrets and variables → Actions

2. **INFISCAL_CLIENT_SECRET**
   - Value: Client Secret from Step 3
   - Location: Settings → Secrets and variables → Actions

3. **INFISCAL_PROJECT_SLUG**
   - Value: Project slug from Step 1 (visible in project URL)
   - Location: Settings → Secrets and variables → Actions
   - Example: `my-chat-app` or `chat-microservices`

### Optional GitHub Secrets

4. **INFISICAL_ENV_SLUG** (default: `prod`)
   - Value: Your environment slug in Infisical
   - Examples: `prod`, `production`, `staging`, `dev`

5. **INFISICAL_SECRET_PATH** (default: `/`)
   - Value: Path to secrets in Infisical
   - Examples: `/`, `/backend`, `/production`

## Step 6: Verify Integration

### Test Locally (Optional)

Install Infisical CLI:
```bash
# macOS
brew install infisical/get-cli/infisical

# Linux
curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | sudo -E bash
sudo apt-get update && sudo apt-get install -y infisical
```

Log in.
Do the local integration test:
```bash
infisical login
infisical secrets --env=prod
```

### Test in GitHub Actions

1. Push a change to the `main` branch.
2. Open the **Actions** tab in GitHub.
3. Monitor the deployment workflow.
4. Find the "Fetch secrets from Infisical" step.
5. Make sure that the output shows "✅ Successfully fetched secrets".

## Secret Flow During Deployment

The documented image-based CI/CD pipeline has this secret flow:

```
1. GitHub Actions starts → CI pipeline triggered
       ↓
2. Run tests → Unit tests, security audits
       ↓
3. Build Docker images → Push to GHCR
       ↓
4. Fetch from Infisical → Secrets retrieved via API
       ↓
5. SSH to VPS → Generate docker-compose.yml with secrets
       ↓
6. Pull images from GHCR → Start services
       ↓
7. Security cleanup → Remove source files
```

The original design lists these security properties:

- CI logs hide all secrets with `::add-mask::`.
- The workflow passes passwords through here-strings, not echo pipes.
- The VPS filesystem does not store secrets.
- The workflow puts secrets directly into docker-compose.yml.

The filesystem claim conflicts with the Compose-file claim and the n8n backup locations recorded below.
This language conversion does not establish which claim describes the deployed pipeline.

## Environment Variables Available in Containers

After deployment, the documented services have access to these variables:

```bash
# Database
ADMIN_USERNAME
ADMIN_PASSWORD
ADMIN_PASSWORD_ENCODED

# Email/SMTP (with defaults if not set)
SMTP_HOST        # Default: smtp-relay.brevo.com
SMTP_USER
SMTP_PASS
EMAIL_FROM       # Default: admin@yourdomain.com
SENDINBLUE_APIKEY

# Application
CORS_ORIGINS
MESSAGE_BROKER_URL
```

## Security Best Practices

### ✅ Do's
- Rotate secrets regularly (every 90 days).
- Use different secrets for dev/staging/prod.
- Enable Infisical audit logs.
- Use one machine identity for each environment.
- Set the minimum permissions (read-only).
- When possible, use a separate secret path for each required group.

### ❌ Don'ts
- Do not commit Infisical credentials to Git.
- Do not share machine identity secrets.
- Do not use production secrets in development.
- Give write access only when it is necessary.
- Do not store secrets in VPS .env files. Use Infisical.

## Troubleshooting

### Infisical Connection Failed

```
Error: Failed to authenticate with Infisical
```

**Solutions:**
- Make sure that `INFISICAL_CLIENT_ID` is correct.
- Make sure that `INFISICAL_CLIENT_SECRET` is correct.
- Make sure that the machine identity has access to the project.
- Make sure that the machine identity is not expired.

### Secret Not Found

```
Error: Secret 'ADMIN_PASSWORD' not found
```

**Solutions:**
- Make sure that the secret exists in Infisical.
- Make sure that the environment name matches (`INFISICAL_ENVIRONMENT`).
- Make sure that the secret path is correct (`INFISICAL_SECRET_PATH`).
- Make sure that the machine identity has read access.

### Deployment Uses Old Secrets

Each deployment gets current secrets.
If the deployment uses old values, do these checks:
- Make sure that the deployment script exports the variables correctly.
- Make sure that docker-compose.yml has the correct values.
- Run the deployment again to regenerate docker-compose.yml.

### Email/SMTP Not Working

Examine the CI logs for these warnings:
```
⚠️ SMTP_HOST not set in Infisical, using default
⚠️ EMAIL_FROM not set in Infisical, using default
```

**Solutions:**
- Add the `SMTP_HOST` secret in Infisical (for example, `smtp-relay.brevo.com`).
- Add the `EMAIL_FROM` secret in Infisical (for example, `noreply@yourdomain.com`).
- Make sure that `SMTP_USER` and `SMTP_PASS` are set correctly.
- Examine the notification service logs: `docker compose logs notification`.

## Updating Secrets

1. Update the secret value in the Infisical dashboard.
2. The next deployment uses the new secret.
3. To apply it immediately, use one of these methods:
   - Start a manual deployment in GitHub Actions.
   - Run the workflow again from the Actions tab.

## Alternative: Manual Secret Management

If you do not use Infisical, use these steps:

1. Remove the Infisical integration from the CI workflow.
2. Add secrets directly as GitHub Secrets.
3. Use an `.env` file on the VPS.

See `GITHUB_SECRETS.md` for manual setup instructions.

## Support

- [Infisical Documentation](https://infisical.com/docs)
- [Infisical Discord](https://infisical.com/discord)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)

---

## n8n Encryption Key

The n8n instance at `n8n.ctaprojects.xyz` uses an encryption key for all stored credentials at rest.
These credentials include API keys, OAuth tokens, and database passwords.

> **⚠️  CRITICAL:** Keep a recoverable copy of this key.
> If the key is lost, all stored n8n credentials become permanently unrecoverable.
> Workflows that use those credentials will fail.

### Current Backup Locations

| Location | Access | Notes |
|----------|--------|-------|
| `/opt/n8n/.env` (VPS) | `ubuntu` user | Runtime source — used by the n8n container |
| `/root/secrets-backup/n8n-encryption-key.txt` (VPS) | `root` only (600) | Disaster-recovery backup |

### Adding to Infisical (Recommended)

After you install the Infisical CLI on the VPS, store the key in Infisical:

```bash
# On VPS, after installing Infisical CLI:
infisical secrets set N8N_ENCRYPTION_KEY="$(grep N8N_ENCRYPTION_KEY /opt/n8n/.env | cut -d= -f2)"
```

### Key Rotation

n8n does not support encryption key rotation.
A changed key makes all existing credentials unreadable.
Rotate the key only if you suspect compromise.
Before rotation, prepare to enter all credentials again manually.

The current hardening task excludes credential rotation.
This documentation conversion does not perform rotation or deployment.
