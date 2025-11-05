# Security Guidelines

## Overview
This document outlines the security measures implemented in the chat-microservices stack and provides guidelines for maintaining a secure development and production environment.

## Implemented Security Measures

### 1. Container Security
- **Non-root containers**: All service containers (user, chat, notification, nginx) run as non-privileged users to limit blast radius if compromised.
- **Minimal base images**: Using Alpine-based images to reduce attack surface.
- **Port binding restrictions**: Admin UIs (nosqlclient, nginx) bound to localhost (127.0.0.1) to prevent accidental network exposure.

### 2. Dependency Security
- **Vulnerable package removal**: Removed `sib-api-v3-typescript` from notification-service due to critical transitive vulnerabilities.
- **Safe alternatives**: Replaced with `axios` for direct SendinBlue API calls (see `SendinBlueService.ts`).
- **Regular audits**: CI pipeline runs `npm audit` on every push and PR.
- **Automated scanning**: Trivy container image scanning integrated into CI.

### 3. HTTP Hardening
- **Helmet.js**: Added to all HTTP services for security headers (CSP, HSTS, etc.).
- **Body size limits**: Request body limited to 100KB to prevent large-payload DoS attacks.
- **Global rate limiting**: All services have global rate limits (100-200 req/15min depending on service).
- **Auth rate limiting**: Auth endpoints (`/register`, `/login`) protected with stricter limits (10 requests per 15 minutes).
- **Input validation**: express-validator used for all user inputs with strict validation rules.
- **MongoDB injection protection**: express-mongo-sanitize automatically sanitizes inputs to prevent NoSQL injection.
- **Enhanced cookie security**: httpOnly, secure (in production), and sameSite flags enabled.

### 4. Secrets Management
- **Consolidated secrets**: Single `docker-secrets/app_secrets` file for local dev (gitignored).
- **Environment variable injection**: Secrets loaded via env files, not hardcoded.
- **Example files only**: Only `.example` files are committed; real secrets stay local.

### 5. CI/CD Security
- **Automated security checks**: GitHub Actions workflows for:
  - NPM dependency audits (fails on high/critical vulnerabilities)
  - Container image scanning with Trivy
  - TypeScript type checking
- **Weekly scans**: Scheduled security audits run every Monday at 9am UTC.

## Security Checklist for Developers

### Before Committing
- [ ] No secrets or credentials in code
- [ ] Run `npm audit` in modified services
- [ ] Run TypeScript checks: `npx tsc --noEmit`
- [ ] Test with production-like environment variables

### Before Deploying
- [ ] Rotate all default/example credentials
- [ ] Review and update rate limits for production load
- [ ] Enable HTTPS/TLS for all external endpoints
- [ ] Set `NODE_ENV=production`
- [ ] Enable `secure: true` for cookies in production
- [ ] Configure proper CORS origins (no wildcards)
- [ ] Review container resource limits

### Regular Maintenance
- [ ] Weekly: Review CI security scan results
- [ ] Monthly: Rotate sensitive credentials
- [ ] Monthly: Update dependencies (`npm update`)
- [ ] Quarterly: Review and update security policies

## Known Security Considerations

### Local Development
- **Localhost binding**: Admin UIs only accessible from host machine (127.0.0.1)
- **HTTP only**: Dev environment uses HTTP; production must use HTTPS
- **Weak secrets**: Demo credentials should be rotated before production use

### Production Recommendations
1. **TLS/HTTPS**: Use reverse proxy (e.g., nginx with Let's Encrypt) for TLS termination
2. **Secret management**: Use proper secret management (AWS Secrets Manager, HashiCorp Vault, etc.)
3. **Database security**: 
   - Use unique credentials per service
   - Enable MongoDB authentication and authorization
   - Restrict network access to database
4. **Network isolation**: Use Docker networks to isolate services
5. **Monitoring**: Implement logging, monitoring, and alerting (e.g., ELK stack, Prometheus)
6. **Rate limiting**: Adjust rate limits based on actual traffic patterns
7. **WAF**: Consider adding a Web Application Firewall for production

## Credential Rotation

### If Secrets Were Exposed
If any credentials were accidentally committed or exposed:

1. **Rotate immediately**:
   - MongoDB admin password
   - CloudAMQP (RabbitMQ) credentials
   - SendinBlue API key
   - SMTP credentials
   - JWT secrets

2. **Check git history**:
   ```bash
   git log --all --full-history -- docker-secrets/app_secrets
   ```

3. **Remove from history** (if needed):
   ```bash
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch docker-secrets/app_secrets" \
     --prune-empty --tag-name-filter cat -- --all
   ```

4. **Force push** (coordinate with team):
   ```bash
   git push origin --force --all
   ```

## Vulnerability Response

### When CI Security Check Fails
1. Review the vulnerability details in CI logs or GitHub Security tab
2. Check if a patch is available: `npm audit fix`
3. If no automatic fix: evaluate alternatives or upgrade dependencies
4. If critical and no fix available: consider removing the dependency
5. Document the decision in a GitHub issue

### Reporting Security Issues
If you discover a security vulnerability, please:
1. **Do NOT** open a public issue
2. Email the security contact: [Your security email]
3. Include: description, steps to reproduce, potential impact
4. Wait for acknowledgment before public disclosure

## Additional Resources
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)

## Contact
For security concerns, contact: [Add your security contact]

Last updated: 2025-11-06
