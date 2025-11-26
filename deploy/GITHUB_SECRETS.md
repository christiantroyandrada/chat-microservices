# GitHub Secrets Configuration

This document lists all the secrets required for automated deployment to your VPS.

## How to Add Secrets

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Enter the name and value, then click **Add secret**

## Required Secrets for Backend Deployment

### Infisical Secrets (Required for Production)

#### INFISICAL_CLIENT_ID
- **Description**: Infisical machine identity client ID
- **Required**: Yes (for production deployment)
- **How to get**: Create a machine identity in Infisical dashboard

#### INFISICAL_CLIENT_SECRET
- **Description**: Infisical machine identity client secret
- **Required**: Yes (for production deployment)
- **How to get**: Generated when creating machine identity

#### INFISICAL_PROJECT_ID
- **Description**: Your Infisical project ID
- **Required**: Yes (for production deployment)
- **How to get**: Found in Infisical project settings

#### INFISICAL_ENVIRONMENT
- **Description**: Infisical environment name
- **Example**: `prod`, `production`, `staging`
- **Default**: `prod` (if not set)
- **Required**: No

#### INFISICAL_SECRET_PATH
- **Description**: Path to secrets in Infisical
- **Example**: `/`, `/backend`, `/production`
- **Default**: `/` (if not set)
- **Required**: No

### VPS Connection Secrets

### VPS_HOST
- **Description**: IP address or domain name of your VPS
- **Example**: `192.168.1.100` or `chat.example.com`
- **Required**: Yes

### VPS_USER
- **Description**: SSH username with Docker permissions
- **Example**: `deploy`
- **Required**: Yes
- **Note**: This user must have Docker access and sudo privileges

### VPS_SSH_PRIVATE_KEY
- **Description**: Private SSH key for authentication
- **Required**: Yes
- **How to generate**:
  ```bash
  # On your VPS
  ssh-keygen -t ed25519 -C "github-actions-deploy"
  cat ~/.ssh/id_ed25519  # Copy this content
  ```
- **Format**: Copy the entire private key including:
  ```
  -----BEGIN OPENSSH PRIVATE KEY-----
  [key content]
  -----END OPENSSH PRIVATE KEY-----
  ```

## Optional Secrets

### VPS_PORT
- **Description**: SSH port number
- **Example**: `22`
- **Default**: `22` (if not set)
- **Required**: No

### DEPLOY_PATH
- **Description**: Deployment directory on VPS
- **Example**: `/opt/chat-app`
- **Default**: `/opt/chat-app` (if not set)
- **Required**: No

### ADMIN_USERNAME
- **Description**: PostgreSQL admin username
- **Example**: `postgres` or `chatapp_admin`
- **Default**: `postgres` (if not set)
- **Required**: **Fetched from Infisical** (fallback to .env file on VPS)
- **Note**: This is automatically retrieved from Infisical during deployment

### ADMIN_PASSWORD
- **Description**: PostgreSQL admin password
- **Example**: `YourSecurePassword123!`
- **Required**: **Fetched from Infisical** (fallback to .env file on VPS)
- **Security**: Use a strong, randomly generated password
- **Note**: This is automatically retrieved from Infisical during deployment

### PGADMIN_EMAIL
- **Description**: pgAdmin login email address
- **Example**: `admin@example.com`
- **Default**: `admin@admin.com` (if not set)
- **Required**: No

## Repository-Specific Secrets

Both `chat-user-microservice` (backend) and `chat-microservices-frontend` repositories need:

**Essential:**
- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_PRIVATE_KEY`

**Infisical Integration:**
- `INFISICAL_CLIENT_ID`
- `INFISICAL_CLIENT_SECRET`
- `INFISICAL_PROJECT_ID`
- `INFISICAL_ENVIRONMENT` (optional)
- `INFISICAL_SECRET_PATH` (optional)

**Optional:**
- `VPS_PORT` (optional)
- `DEPLOY_PATH` (optional)
- `PGADMIN_EMAIL` (optional)

## Infisical Setup

### Secrets Stored in Infisical

The following secrets are retrieved from Infisical during deployment:

**Database:**
- `ADMIN_USERNAME` - PostgreSQL admin username
- `ADMIN_PASSWORD` - PostgreSQL admin password
- `ADMIN_PASSWORD_ENCODED` - URL-encoded admin password

**Application:**
- `CORS_ORIGINS` - Allowed CORS origins
- `MESSAGE_BROKER_URL` - RabbitMQ connection URL
- `SENDINBLUE_APIKEY` - SendinBlue API key for emails
- `SMTP_PASS` - SMTP password
- `SMTP_USER` - SMTP username

### Creating Infisical Machine Identity

1. Go to your Infisical project
2. Navigate to **Access Control** → **Machine Identities**
3. Click **Create Machine Identity**
4. Name it `github-actions-deploy`
5. Copy the **Client ID** and **Client Secret**
6. Add these as GitHub secrets:
   - `INFISICAL_CLIENT_ID`
   - `INFISICAL_CLIENT_SECRET`
7. Grant the machine identity access to your production environment

## Security Best Practices

1. **Never commit secrets to Git** - Use GitHub Secrets only
2. **Use strong SSH keys** - Ed25519 or RSA 4096-bit minimum
3. **Rotate keys regularly** - Change SSH keys every 90 days
4. **Limit access** - Only give necessary permissions to deploy user
5. **Use separate keys** - Don't reuse SSH keys across environments
6. **Enable 2FA** - On your GitHub account for extra security

## Verification

After adding secrets, you can verify they're set correctly:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. You should see all required secrets listed (values are hidden)
3. Test deployment by pushing to main branch

## Troubleshooting

### SSH Connection Failed
- Verify `VPS_HOST` is correct and accessible
- Check `VPS_PORT` if using non-standard port
- Ensure SSH key has correct permissions on VPS (`chmod 600 ~/.ssh/authorized_keys`)

### Permission Denied
- Verify `VPS_USER` exists on VPS
- Ensure user is in `docker` group: `sudo usermod -aG docker deploy`
- Check user has sudo access if needed

### Key Authentication Failed
- Verify private key format (should include BEGIN/END lines)
- Ensure matching public key is in `~/.ssh/authorized_keys` on VPS
- Check SSH service is running: `sudo systemctl status sshd`

## Example Setup Script

Run this on your VPS to prepare for deployment:

```bash
#!/bin/bash
# Create deploy user
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo usermod -aG sudo deploy

# Switch to deploy user
sudo su - deploy

# Generate SSH key
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/id_ed25519 -N ""

# Setup authorized_keys
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
chmod 700 ~/.ssh

# Display private key to copy to GitHub
echo "=== Copy this private key to GitHub Secret: VPS_SSH_PRIVATE_KEY ==="
cat ~/.ssh/id_ed25519
echo "=== End of private key ==="
```

## Related Documentation

- [Main Deployment Guide](./README.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [SSH Key Generation Guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent)
