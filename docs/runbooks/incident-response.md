# Production Incident Response Runbook

## Quick Reference

| Service | Port | Health Endpoint | Docker Container |
|---|---|---|---|
| user-service | 8081 | `GET /health` | `chat-app-user-service-1` |
| chat-service | 8082 | `GET /health` | `chat-app-chat-service-1` |
| notification-service | 8083 | `GET /health` | `chat-app-notification-service-1` |
| NGINX | 80/443 | N/A | `chat-app-nginx-1` |
| PostgreSQL | 5432 | N/A | `chat-app-postgres-1` |
| RabbitMQ | 5672/15672 | `GET :15672/api/healthchecks/node` | `chat-app-rabbitmq-1` |

## Health Check Response Format

```json
{
  "status": "ok | degraded | error",
  "service": "service-name",
  "checks": {
    "database": true,
    "rabbitmq": true
  }
}
```

- **200**: All checks pass (`status: ok`).
- **503**: One or more checks fail (`status: degraded` or `error`).

---

## Incident Playbooks

### 1. Service Returns 503 / Health Degraded

**Symptoms**: The health endpoint returns `status: degraded`. One or more `checks` have the value `false`.

**Diagnosis**:
```bash
# Check which checks are failing
curl -s http://localhost:808X/health | jq

# Check container logs
docker logs --tail 100 -f chat-app-SERVICE-1

# Check container resource usage
docker stats --no-stream
```

**Resolution by failing check**:

| Failing Check | Action |
|---|---|
| `database: false` | See Playbook #2 (Database Down) |
| `rabbitmq: false` | See Playbook #3 (RabbitMQ Down) |

### 2. Database Down / Connection Refused

**Symptoms**: Health checks contain `database: false`. Logs contain `ECONNREFUSED`.

**Diagnosis**:
```bash
# Check PostgreSQL container
docker logs --tail 50 chat-app-postgres-1
docker exec chat-app-postgres-1 pg_isready -U postgres

# Check disk space (PostgreSQL may refuse writes)
docker exec chat-app-postgres-1 df -h /var/lib/postgresql/data
```

**Resolution**:
1. If the container stopped after a failure, run `docker compose up -d postgres`.
2. If insufficient memory stopped the container, increase memory limits in `docker-compose.prod.yml`.
3. If the disk is full, run `VACUUM FULL` or increase the volume capacity.
4. If data is corrupt, restore the latest backup. See the Backup section.

**Post-recovery**: Services automatically reconnect through TypeORM.

Verify recovery with health checks.

### 3. RabbitMQ Down / Connection Lost

**Symptoms**: Health checks contain `rabbitmq: false`. Service logs contain "RabbitMQ connection closed".

**Diagnosis**:
```bash
# Check RabbitMQ container
docker logs --tail 50 chat-app-rabbitmq-1
docker exec chat-app-rabbitmq-1 rabbitmqctl status

# Check queue depth
docker exec chat-app-rabbitmq-1 rabbitmqctl list_queues name messages consumers
```

**Resolution**:
1. If the container stopped after a failure, run `docker compose up -d rabbitmq`.
2. All 3 services reconnect automatically with exponential backoff (max 10 attempts).
   Exponential backoff increases the delay between connection attempts.
3. If all reconnection attempts fail, run `docker compose restart user-service chat-service notification-service`.

**Impact during outage**:
- **user-service**: User registration emails stay in the queue until recovery.
- **chat-service**: The service still stores messages in the database and delivers them through WebSocket. It does not send push notifications.
  Remote procedure calls (RPC) for usernames fail. The service uses cached results when available.
- **notification-service**: The service stops reading the queue until reconnection.

### 4. WebSocket Connections Dropping

**Symptoms**: Users report "disconnected" status, repeated reconnection attempts, or messages that do not appear immediately.

**Diagnosis**:
```bash
# Check NGINX upstream connectivity
docker logs --tail 100 chat-app-nginx-1 | grep -i "upstream"

# Check chat-service active connections
docker logs --tail 100 chat-app-chat-service-1 | grep -i "socket\|connect\|disconnect"

# Check if event loop is blocked
docker exec chat-app-chat-service-1 node -e "console.log(process.memoryUsage())"
```

**Resolution**:
The NGINX `proxy_read_timeout` should be ≥ 120s for WebSocket.

1. Do a check of NGINX `proxy_read_timeout`.
2. Do a check of chat-service for insufficient memory: `docker stats --no-stream chat-app-chat-service-1`.
3. If you suspect a memory leak, do a rolling restart with `docker compose restart chat-service`.

### 5. Notification Emails Not Sending

**Symptoms**: Users do not receive registration or message notification emails.

**Diagnosis**:
```bash
# Check notification-service logs
docker logs --tail 100 chat-app-notification-service-1 | grep -i "email\|smtp\|sendinblue"

# Check RabbitMQ queue depth (messages piling up = consumer stuck)
docker exec chat-app-rabbitmq-1 rabbitmqctl list_queues name messages consumers
```

**Resolution**:
1. If queue depth increases, do a check of consumer logs for errors.
2. If SMTP times out, verify the `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` environment variables.
3. If the SendinBlue API returns errors, do a check of `SENDINBLUE_APIKEY` validity and rate limits.
4. If messages are malformed, do a check of the `NOTIFICATIONS` queue for messages that cannot be processed.
5. Remove these messages with `node notification-service/scripts/purgeQueue.js`.

---

## Container Management

```bash
# Restart a single service
docker compose restart SERVICE_NAME

# View real-time logs
docker compose logs -f --tail 100

# Full system restart (ordered)
docker compose down
docker compose up -d postgres rabbitmq
sleep 10  # Wait for DB and MQ to initialize
docker compose up -d user-service chat-service notification-service nginx

# Force rebuild (after code changes)
docker compose build --no-cache SERVICE_NAME
docker compose up -d SERVICE_NAME
```

## Backup & Recovery

```bash
# Database backup
docker exec chat-app-postgres-1 pg_dump -U postgres chat_db > backup_$(date +%Y%m%d_%H%M%S).sql

# Database restore
cat backup.sql | docker exec -i chat-app-postgres-1 psql -U postgres chat_db
```

## Rollback Procedure

If a deployment introduces regressions and leaves the system unhealthy, use the rollback procedure that follows.

### Quick Rollback (Revert to Previous Image)

```bash
cd /opt/chat-app/chat-microservices

# 1. Find the previous image tag (the SHA before the current one)
docker compose images

# 2. Update docker-compose.yml to use the previous image tag
#    Replace the IMAGE_TAG value with the previous SHA, then:
export IMAGE_TAG=<previous-commit-sha>

# 3. Pull the old images and restart
docker compose pull
for SERVICE in user chat notification; do
  docker compose up -d --no-deps $SERVICE
  echo "Waiting for $SERVICE health..."
  sleep 10
done
docker compose up -d --no-deps nginx

# 4. Verify health
for EP in /health /api/user/health /chat/health /notifications/health; do
  curl -sf "http://localhost:80${EP}" && echo " ✅ ${EP}" || echo " ❌ ${EP}"
done
```

### Database Rollback

If the release included a destructive migration:

```bash
# 1. Stop all application services (keep postgres running)
docker compose stop user chat notification

# 2. Restore from latest backup
cat backup_YYYYMMDD_HHMMSS.sql | docker exec -i chat-app-postgres-1 psql -U postgres chat_db

# 3. Deploy the previous image tag (see Quick Rollback above)
```

### Post-Rollback Checklist

1. Verify that all 4 health endpoints return 200.
2. Do a test of the login and message send procedure manually.
3. Verify that RabbitMQ queue depth does not increase: `docker exec chat-app-rabbitmq-1 rabbitmqctl list_queues`.
4. Monitor logs for 15 minutes: `docker compose logs -f --tail=50`.
5. Open an incident report that describes the failed deployment.

---

## Escalation

If an incident remains unresolved after 15 minutes, do these steps:
1. Do a check of all service health endpoints.
   List the failed checks.
2. Collect logs from all containers: `docker compose logs --tail 200 > incident_logs.txt`.
3. Do a check of system resources: `docker stats --no-stream > resource_snapshot.txt`.
4. Escalate with both files attached.
