# Security Guidelines

This document describes security measures in the chat-microservices stack. It gives guidance for secure development and production environments.

Historical audit results below do not give current release approval. Current hardening is incomplete.
Task6A is approved. Task6B has five Important findings that need correction.

## Security Principles

The project uses these security principles:
- **OWASP Top 10** security standards
- **Defense in Depth** strategy (multiple security layers)
- **Principle of Least Privilege**
- **Zero-Trust Architecture** for E2EE key management

---

<a id="-latest-security-updates-november-2025"></a>
## Latest Security Updates (November 2025)

This section records historical security changes and results from November 2025.

<a id="client-side-encrypted-key-backup-november-17-2025-"></a>
### Client-Side Encrypted Key Backup (November 17, 2025)

**Major Security Overhaul**: The implementation added a zero-knowledge architecture for Signal Protocol key management.
In this architecture, the server cannot read plaintext keys.

**Security Improvements**:
- **Client-side AES-256-GCM encryption**: The browser encrypts keys before backend storage.
- **PBKDF2 key derivation**: Password-based encryption uses 100,000 iterations. The source record describes this value as OWASP compliant.
- **Zero-knowledge backend**: The server stores only encrypted data. It never receives plaintext keys.
- **Device isolation**: Each device has a separate encrypted backup with device ID validation.
- **Rate limiting**: The limit is 1 key backup per 24 hours to prevent abuse.
- **Audit logging**: The service records all key operations (STORE_KEYS, FETCH_KEYS).
- **Information disclosure prevention**: Error responses take a constant time.

**Implementation Details**:
- **Frontend**: `keyEncryption.ts` with Web Crypto API (AES-256-GCM, PBKDF2)
- **Backend**: `PrekeyController.ts` with device-specific key isolation and audit logging
- **Database**: Stores `_encryptedKeyBundle` instead of plaintext keys
- **Security Model**: Defense-in-depth uses multiple security layers. A server compromise does not expose user keys.

**Vulnerabilities Fixed** (from SECURITY_AUDIT_SIGNAL_KEYS.md):
- CVE-001 (Critical): Plaintext private key storage → **FIXED**
- CVE-002 (Critical): No key derivation function → **FIXED**
- CVE-003 (Critical): Unencrypted key transport → **FIXED**
- CVE-005 (High): Missing device isolation → **FIXED**
- CVE-007 (Medium): Weak PBKDF2 iterations → **FIXED**
- CVE-008 (High): No rate limiting → **FIXED**
- CVE-010 (Medium): No audit logging → **FIXED**
- CVE-011 (Low): Information disclosure → **FIXED**

**Security Score Upgrade**: The recorded risk changed from Critical (9.5/10 risk) to Low-Medium (3.5/10 risk).

---

<a id="end-to-end-encryption-e2ee-"></a>
### End-to-End Encryption (E2EE)

**Implementation**: The client uses Signal Protocol for message encryption.

- **Client-side encryption**: The sender's device encrypts all messages before transmission.
- **Signal Protocol**: The client uses the industry-standard E2EE protocol (X3DH + Double Ratchet).
- **Prekey bundles**: The client generates and publishes bundles automatically during registration/login.
- **Session management**: The client establishes secure sessions between users.
- **Backend agnostic**: The server stores encrypted data and cannot read message content.

**Key Features**:
- The client encrypts messages with Signal Protocol before sending them.
- The server stores only encrypted message content.
- Recipients automatically decrypt messages in the browser.
- IndexedDB stores keys in separate databases for each device.
- The client generates prekey bundles automatically during registration/login.
- **NEW**: The encrypted key backup has optional password protection.

**Implementation Details**:
- Library: `@privacyresearch/libsignal-protocol-typescript`
- Storage: IndexedDB for identity keys, prekeys, and sessions
- Key generation: Automatic on user registration with device ID
- Session bootstrapping: Automatic on first message to new contact
- **NEW**: Client-side key encryption before backend storage (optional)

<a id="postgresql-migration-"></a>
### PostgreSQL Migration

**Database Migration:** The implementation migrated from MongoDB to PostgreSQL with TypeORM.

<a id="critical-fixes-applied-today-"></a>
### Historical Critical Fixes

The original record called these changes "Applied Today". The source does not give a separate date for these fixes.

1. **CRITICAL FIXED:** The implementation removed `synchronize: true` in production.
   - **Risk:** Automatic migration could change the production schema and cause data loss.
   - **Fix:** All 3 services changed to `synchronize: config.env !== 'production'`.
   - **Impact:** The database schema is stable in production.

2. **HIGH FIXED:** The implementation added connection pooling.
   - **Risk:** High load could reduce performance and use all available connections.
   - **Fix:** The connection pool uses min: 5, max: 20, timeout: 2s, idle: 30s.
   - **Impact:** The change improves resource use and performance.

3. **HIGH FIXED:** The implementation added query execution monitoring.
   - **Risk:** Slow queries could reduce performance without detection.
   - **Fix:** The implementation enabled `maxQueryExecutionTime: 1000ms` logging.
   - **Impact:** Operators can identify and improve slow queries.

4. **HIGH FIXED:** The implementation added database indexes.
   - **Risk:** Queries for message conversations and notifications could be slow.
   - **Fix:** The implementation added composite indexes on Message (senderId+receiverId) and Notification (userId+createdAt).
   - **Impact:** Query performance is significantly faster.

### Security Audit Summary

**Overall Security Score: A (92/100)**. The recorded score increased from A- (90/100).

**Recorded strengths:**
- JWT authentication with httpOnly cookies
- Input validation with express-validator
- SQL injection protection via TypeORM parameterized queries
- bcrypt password hashing (cost factor 12)
- Helmet.js security headers
- Rate limiting (global + auth-specific)
- CORS with explicit origins
- 0 npm vulnerabilities in all services
- Connection pooling and query timeouts
- Database indexes for performance
- **Distroless runtime images** with minimal attack surface
- **Pinned image digests** for reproducible builds
- **Multi-stage hardened builds** (npm cache clean, prune production)

**Remaining Recommendations (Optional Improvements):**

**MEDIUM Priority:**
- Redis-based rate limiting for multi-instance deployments
- JWT secret rotation mechanism
- Request ID tracking for distributed tracing
- Compression middleware (gzip/brotli)
- Database connection retry logic with exponential backoff

**LOW Priority:**
- Database query result caching
- Structured logging (Winston/Pino)
- Health check endpoints for dependencies

### Production Deployment Checklist

Before deployment to production, complete this checklist:
- [x] Database connection pooling configured
- [x] synchronize disabled in production
- [x] Query execution monitoring enabled
- [x] Database indexes created
- [x] Container images use distroless runtime
- [x] Builder and runtime images pinned to digests
- [x] Build hardening applied (npm cache clean, prune production)
- [x] TypeORM migrations created (idempotent with hasTable checks)
- [x] HTTPS/TLS enabled with Let's Encrypt SSL certificates
- [x] pgAdmin accessible via /pgadmin/ route (protected by nginx)
- [ ] All default credentials rotated
- [ ] Environment variables set correctly (NODE_ENV=production)
- [ ] Rate limits adjusted for production load
- [ ] Monitoring and alerting configured
- [ ] Backup strategy implemented
- [ ] Scheduled image rebuilds configured (weekly/monthly for OS patches)

---

<a id="-previous-security-audit-november-8-2025"></a>
## Previous Security Audit (November 8, 2025)

The historical security audit identified and corrected **6 critical vulnerabilities**:

1. **CRITICAL FIXED:** JWT authentication middleware for Socket.IO corrected unauthenticated WebSocket access.
2. **HIGH FIXED:** Content length and type validation corrected missing backend message validation.
3. **HIGH FIXED:** Regex special character escaping corrected NoSQL injection/ReDoS in user search.
4. **HIGH FIXED:** Try-catch error handling corrected unhandled JSON.parse errors in RabbitMQ.
5. **MEDIUM FIXED:** The bcrypt cost factor increased from 10 to 12.
6. **MEDIUM FIXED:** A 1MB size limit corrected unlimited WebSocket message size.

---

## Implemented Security Measures

### 1. Authentication & Authorization
- **JWT-based authentication**: The service signs and verifies tokens. Tokens expire after 1 day.
- **Bearer token support**: The service accepts tokens in HTTP headers. If necessary, it uses cookies instead.
- **WebSocket authentication**: The Socket.IO handshake requires JWT (added Nov 2025).
- **Sender validation**: Users can send messages only as themselves.
- **Password hashing**: The service uses bcrypt with cost factor 12 (upgraded from 10).
- **Password requirements**: Passwords require 8-128 chars, uppercase, lowercase, a digit, and a special character.

### 2. Input Validation & Sanitization
- **express-validator**: The service applies strict validation rules to all user inputs.
- **Message validation**: The backend enforces a 5000 character limit and rejects empty messages.
- **Email validation**: The service validates email format and converts addresses to a standard form.
- **Name validation**: Names require 2-50 chars, with letters/spaces/hyphens/apostrophes only.
- **Regex escaping**: The service escapes special characters to prevent ReDoS attacks (added Nov 2025).
  ReDoS is denial of service through regular expressions.
- **Frontend XSS protection**: The frontend encodes HTML entities through sanitizeHtml to prevent cross-site scripting (XSS).

### 3. Container Security
- **Non-root containers**: All service containers (user, chat, notification, nginx) run as users without elevated privileges.
  If a container is compromised, these permissions limit the damage.
- **Minimal base images**: Alpine-based images reduce components that attackers can exploit.
- **Port binding restrictions**: Administration interfaces (nosqlclient, nginx) bind to localhost (127.0.0.1) to prevent accidental network exposure.

### 4. Dependency Security
- **Vulnerable package removal**: The implementation removed `sib-api-v3-typescript` from notification-service because its dependencies had critical vulnerabilities.
- **Safe alternatives**: The implementation substituted `axios` for direct SendinBlue API calls. See `SendinBlueService.ts`.
- **Regular audits**: The CI pipeline runs `npm audit` on every push and PR.
- **Automated scanning**: CI includes Trivy container image scanning.

### 5. HTTP Hardening
- **Helmet.js**: All HTTP services use Helmet.js for security headers (CSP, HSTS, X-Frame-Options, and others).
- **Body size limits**: The request body limit is 100KB to prevent denial-of-service (DoS) attacks through large requests.
- **WebSocket size limits**: Socket.IO messages have a 1MB limit (added Nov 2025).
- **Global rate limiting**: All services have global rate limits (100-200 req/15min depending on service).
- **Auth rate limiting**: Authentication endpoints (`/register`, `/login`) have stricter limits (10 requests per 15 minutes).
- **CORS configuration**: The configuration lists permitted origins, enables credentials, and excludes wildcards.
  CORS controls cross-origin resource sharing.
- **Enhanced cookie security**: The httpOnly, secure (in production), and sameSite flags are enabled.

### 6. Database Security
- **PostgreSQL with TypeORM**: The implementation replaced MongoDB/Mongoose (Nov 2025).
- **Parameterized queries**: The TypeORM repository pattern and parameterized SQL prevent SQL injection.
- **Connection pooling**: The configured pool (min: 5, max: 20) improves reliability and performance.
- **Query monitoring**: The service records queries that exceed 1000ms to help improve performance.
- **Schema protection**: Production disables synchronize to prevent accidental migrations.
- **Database indexes**: Composite indexes on foreign keys improve query performance.
- **Password exclusion**: The service never returns password fields (select: false in entity).
- **UUID primary keys**: The service uses UUID v4 for better security than sequential IDs.
- **Connection security**: Credentials come only from environment variables.

### 7. Error Handling & Resilience
- **RabbitMQ resilience**: Try-catch surrounds all JSON.parse operations (added Nov 2025).
- **Environment-specific errors**: Stack traces appear only in development mode.
- **Graceful degradation**: Services process malformed queue messages without stopping unexpectedly.

### 8. Secrets Management
- **Consolidated secrets**: Local development uses one `docker-secrets/app_secrets` file (gitignored).
- **Environment variable injection**: The service loads secrets through env files. Secrets are not embedded in source code.
- **Example files only**: Only `.example` files are committed. Real secrets stay local.
- **Secret validation**: Startup checks give warnings about default or weak secrets.

<a id="9-container-image-security-november-2025-"></a>
### 9. Container Image Security (November 2025)

**Distroless Runtime Migration**: All Node.js services migrated to minimal distroless runtime images.

- **Multi-stage builds**: Builds use a builder stage (Node.js slim) and a minimal runtime stage (distroless).
- **Distroless runtime**: The user/chat/notification services use `gcr.io/distroless/nodejs22-debian13:nonroot`.
- **Pinned builder digest**: The official Node.js 22 slim image uses digest `sha256:204476c3121ff0...` for reproducible builds.
- **Vendor nginx image**: Bitnami nginx uses digest `sha256:8fed12f41a27...` (0 vulnerabilities).
- **Build hardening**: Builds use `npm ci`, `npm cache clean --force`, and `npm prune --production` to minimize components that attackers can exploit.
- **Non-root execution**: All services run as a non-root user in the distroless runtime.
- **No shell/package manager**: Distroless images contain only the Node.js runtime and application code.
- **Vulnerability scan results** (Nov 18, 2025):
  - user-service: 12 LOW severity (Debian OS packages, no MEDIUM/HIGH/CRITICAL)
  - chat-service: 12 LOW severity (Debian OS packages, no MEDIUM/HIGH/CRITICAL)
  - notification-service: 12 LOW severity (Debian OS packages, no MEDIUM/HIGH/CRITICAL)
  - nginx: 0 vulnerabilities (vendor-pinned Bitnami image)

**Benefits**:
- The images have fewer components that attackers can exploit (no shell, package manager, or unnecessary tools).
- Image sizes are smaller (distroless runtime ~50MB vs full Node ~200MB).
- The images improve security through non-root execution and minimal packages.
- Digest pinning makes builds reproducible.
- The images have fewer vulnerabilities because they contain only runtime dependencies.

### 10. CI/CD Security
- **Automated security checks**: GitHub Actions workflows do these checks:
  - NPM dependency audits fail on high/critical vulnerabilities.
  - Trivy scans container images for vulnerabilities and secrets.
  - TypeScript does type checks.
- **Weekly scans**: Scheduled security audits run every Monday at 9am UTC.

## Security Checklist for Developers

### Before Committing
- [ ] Verify that the code contains no secrets or credentials.
- [ ] Run `npm audit` in modified services.
- [ ] Run TypeScript checks: `npx tsc --noEmit`.
- [ ] Do a test with production-like environment variables.

### Before Deploying
- [ ] Rotate all default/example credentials.
- [ ] Review rate limits for production load. Update the rate limits.
- [ ] Enable HTTPS/TLS for all external endpoints.
- [ ] Set `NODE_ENV=production`.
- [ ] Enable `secure: true` for cookies in production.
- [ ] Configure correct CORS origins (no wildcards).
- [ ] Review container resource limits.

### Regular Maintenance
- [ ] Weekly: Review CI security scan results.
- [ ] Monthly: Rotate sensitive credentials.
- [ ] Monthly: Update dependencies (`npm update`).
- [ ] Quarterly: Review security policies. Update the policies.

## Known Security Considerations

### Local Development
- **Localhost binding**: Administration interfaces are accessible only from the host machine (127.0.0.1).
- **HTTP only**: The development environment uses HTTP. Production must use HTTPS.
- **Weak secrets**: Demo credentials should be rotated before production use.

### Production Recommendations
1. **TLS/HTTPS**: Use a reverse proxy for TLS termination (e.g., nginx with Let's Encrypt).
2. **Secret management**: Use a secret management system (AWS Secrets Manager, HashiCorp Vault, etc.).
3. **Database security**: 
   - Use unique credentials for each service.
   - Enable PostgreSQL SSL/TLS connections.
   - Restrict network access to the database with firewall rules.
   - Implement regular automatic backups with recovery to a specified point in time.
   - Consider row-level security (RLS) for systems with multiple tenants.
   - Use read replicas to increase read operation capacity.
4. **Network isolation**: Use Docker networks to isolate services.
5. **Monitoring**: Implement logging, monitoring, and alerts (e.g., ELK stack, Prometheus).
6. **Rate limiting**: Consider Redis-backed rate limiting for distributed deployments.
7. **WAF**: Consider a Web Application Firewall for production.
8. **Refresh tokens**: Implement short-lived access tokens (15min) + long-lived refresh tokens.
9. **Account lockout**: After N failed login attempts, add temporary account lockout.
10. **Email verification**: Before account activation, require email confirmation.
11. **Audit logging**: Record authentication events, message sends, and sensitive operations.
12. **TypeORM migrations**: Use migrations instead of synchronize for schema changes.
13. **Database monitoring**: Monitor connection pool use, query performance, and deadlocks.

## Credential Rotation

### If Secrets Were Exposed
If any credentials were accidentally committed or exposed, do these steps:

1. Rotate these credentials immediately:
   - PostgreSQL admin password
   - CloudAMQP (RabbitMQ) credentials
   - SendinBlue API key
   - SMTP credentials
   - JWT secrets
   - DATABASE_URL connection string

2. Do a check of Git history:
   ```bash
   git log --all --full-history -- docker-secrets/app_secrets
   ```

3. If necessary, remove the credentials from history:
   ```bash
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch docker-secrets/app_secrets" \
     --prune-empty --tag-name-filter cat -- --all
   ```

4. Coordinate the force push with the team.
5. Force push:
   ```bash
   git push origin --force --all
   ```

## Vulnerability Response

### When CI Security Check Fails
1. Review the vulnerability details in CI logs or the GitHub Security tab.
2. Do a check for an available patch: `npm audit fix`.
3. If no automatic fix is available, evaluate alternatives or upgrade dependencies.
4. If the vulnerability is critical and no fix is available, consider removal of the dependency.
5. Record the decision in a GitHub issue.

### Reporting Security Issues
If you discover a security vulnerability, use this procedure:
1. Do not open a public issue.
2. Email the security contact: [Your security email].
3. Include a description, steps to reproduce the vulnerability, and its possible effect.
4. Wait for acknowledgment before public disclosure.

## Additional Resources
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [JWT Best Practices (RFC 8725)](https://tools.ietf.org/html/rfc8725)
- [PostgreSQL Security Best Practices](https://www.postgresql.org/docs/current/security.html)
- [TypeORM Security Guide](https://typeorm.io/)

## Contact
For security concerns, contact [Add your security contact].

Last updated: 2025-11-10 (Security improvements and configuration updates)

Historical minor updates (2025-11-10):
- Frontend authentication changed to use httpOnly cookies. The backend and Socket.IO handshake accept cookies for authentication.
- The Nginx gateway configuration improved WebSocket proxying. It forwards Upgrade/Connection headers and preserves cookies.
- The documentation clarified cookie flags to enforce `HttpOnly`, `SameSite` and `Secure` in production.
