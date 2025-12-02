# Infisical Integration Setup Guide

This guide explains how to integrate Infisical for secret management in your CI/CD pipeline.

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

**Benefits:**
- ✅ Centralized secret management
- ✅ No secrets stored on VPS
- ✅ Secrets fetched fresh on each deployment
- ✅ Easy rotation and updates
- ✅ Audit trail in Infisical

## Step 1: Create Infisical Project

1. Sign up at [Infisical](https://infisical.com/) if you haven't
2. Create a new project for your chat application
3. Note your **Project ID** (found in project settings)

## Step 2: Add Secrets to Infisical

In your Infisical project, add these secrets to your production environment:

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

**Note**: If `SMTP_HOST` or `EMAIL_FROM` are not configured, the CI/CD will use defaults:
- `SMTP_HOST` defaults to `smtp-relay.brevo.com`
- `EMAIL_FROM` defaults to `admin@ctaprojects.xyz`

### Application Secrets (Recommended)
```
CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com
MESSAGE_BROKER_URL=amqp://username:password@rabbitmq:5672
```

## Step 3: Create Machine Identity

Machine identities allow GitHub Actions to authenticate with Infisical:

1. In Infisical, go to **Access Control** → **Machine Identities**
2. Click **Create Machine Identity**
3. Name: `github-actions-deploy`
4. Description: `Machine identity for GitHub Actions CI/CD`
5. Click **Create**
6. **Important**: Copy the **Client ID** and **Client Secret** (shown only once!)

## Step 4: Grant Access to Machine Identity

1. Go to your project settings
2. Navigate to **Access Control** → **Machine Identities**
3. Find `github-actions-deploy` and click **Add to Project**
4. Select environment: `production` (or your environment name)
5. Set permissions: **Read** (minimum required)
6. Set path: `/` (or specific path if you organize secrets)

## Step 5: Add Secrets to GitHub

Add these secrets to **both** repositories:

### Required GitHub Secrets

> **Note**: The workflow uses `INFISCAL_*` (without 'I') to match existing configuration.

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

Login and test:
```bash
infisical login
infisical secrets --env=prod
```

### Test in GitHub Actions

1. Push a change to the `main` branch
2. Go to **Actions** tab in GitHub
3. Watch the deployment workflow
4. Check for "Fetch secrets from Infisical" step
5. Should see: ✅ Successfully fetched secrets

## Secret Flow During Deployment

The new image-based CI/CD pipeline handles secrets as follows:

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

**Security Features:**
- ✅ All secrets masked with `::add-mask::` in CI logs
- ✅ Passwords passed via here-strings (not echo pipes)
- ✅ No secrets stored on VPS filesystem
- ✅ Secrets injected directly into docker-compose.yml

## Environment Variables Available in Containers

After deployment, your services have access to:

```bash
# Database
ADMIN_USERNAME
ADMIN_PASSWORD
ADMIN_PASSWORD_ENCODED

# Email/SMTP (with defaults if not set)
SMTP_HOST        # Default: smtp-relay.brevo.com
SMTP_USER
SMTP_PASS
EMAIL_FROM       # Default: admin@ctaprojects.xyz
SENDINBLUE_APIKEY

# Application
CORS_ORIGINS
MESSAGE_BROKER_URL
```

## Security Best Practices

### ✅ Do's
- Rotate secrets regularly (every 90 days)
- Use different secrets for dev/staging/prod
- Enable Infisical audit logs
- Use machine identity per environment
- Set minimal permissions (read-only)
- Use specific secret paths when possible

### ❌ Don'ts
- Don't commit Infisical credentials to Git
- Don't share machine identity secrets
- Don't use production secrets in development
- Don't give write access unless needed
- Don't store secrets in VPS .env files (use Infisical)

## Troubleshooting

### Infisical Connection Failed

```
Error: Failed to authenticate with Infisical
```

**Solutions:**
- Verify `INFISICAL_CLIENT_ID` is correct
- Verify `INFISICAL_CLIENT_SECRET` is correct
- Check machine identity has access to project
- Ensure machine identity is not expired

### Secret Not Found

```
Error: Secret 'ADMIN_PASSWORD' not found
```

**Solutions:**
- Verify secret exists in Infisical
- Check environment name matches (`INFISICAL_ENVIRONMENT`)
- Check secret path is correct (`INFISICAL_SECRET_PATH`)
- Ensure machine identity has read access

### Deployment Uses Old Secrets

**Solution:** Secrets are fetched fresh on each deployment. If old values are being used:
- Verify deployment script exports variables correctly
- Check docker-compose.yml has correct values
- Re-run deployment to regenerate docker-compose.yml

### Email/SMTP Not Working

**Check CI logs for these warnings:**
```
⚠️ SMTP_HOST not set in Infisical, using default
⚠️ EMAIL_FROM not set in Infisical, using default
```

**Solutions:**
- Add `SMTP_HOST` secret in Infisical (e.g., `smtp-relay.brevo.com`)
- Add `EMAIL_FROM` secret in Infisical (e.g., `noreply@yourdomain.com`)
- Verify `SMTP_USER` and `SMTP_PASS` are set correctly
- Check notification service logs: `docker compose logs notification`

## Updating Secrets

1. Update secret value in Infisical dashboard
2. Secret takes effect on next deployment
3. To apply immediately:
   - Trigger manual deployment in GitHub Actions
   - Or re-run the workflow from the Actions tab

## Alternative: Manual Secret Management

If you prefer not to use Infisical, you can:

1. Remove Infisical integration from CI workflow
2. Add secrets directly as GitHub Secrets
3. Use `.env` file on VPS

See `GITHUB_SECRETS.md` for manual setup instructions.

## Support

- [Infisical Documentation](https://infisical.com/docs)
- [Infisical Discord](https://infisical.com/discord)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
