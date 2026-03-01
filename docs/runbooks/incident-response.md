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

- **200**: All checks pass (`status: ok`)
- **503**: One or more checks fail (`status: degraded` or `error`)

---

## Incident Playbooks

### 1. Service Returns 503 / Health Degraded

**Symptoms**: Health endpoint returns `status: degraded` with one or more `checks` as `false`.

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

**Symptoms**: `database: false` in health checks, `ECONNREFUSED` in logs.

**Diagnosis**:
```bash
# Check PostgreSQL container
docker logs --tail 50 chat-app-postgres-1
docker exec chat-app-postgres-1 pg_isready -U postgres

# Check disk space (PostgreSQL may refuse writes)
docker exec chat-app-postgres-1 df -h /var/lib/postgresql/data
```

**Resolution**:
1. If container crashed: `docker compose up -d postgres`
2. If OOM killed: increase memory limits in `docker-compose.prod.yml`
3. If disk full: run `VACUUM FULL` or expand volume
4. If corruption: restore from latest backup (see Backup section)

**Post-recovery**: Services will automatically reconnect via TypeORM. Verify with health checks.

### 3. RabbitMQ Down / Connection Lost

**Symptoms**: `rabbitmq: false` in health checks, "RabbitMQ connection closed" in service logs.

**Diagnosis**:
```bash
# Check RabbitMQ container
docker logs --tail 50 chat-app-rabbitmq-1
docker exec chat-app-rabbitmq-1 rabbitmqctl status

# Check queue depth
docker exec chat-app-rabbitmq-1 rabbitmqctl list_queues name messages consumers
```

**Resolution**:
1. If container crashed: `docker compose up -d rabbitmq`
2. All 3 services have automatic reconnection with exponential backoff (max 10 attempts).
3. If reconnection exhausted: `docker compose restart user-service chat-service notification-service`

**Impact during outage**:
- **user-service**: User registration emails will not be sent (queued until recovery).
- **chat-service**: Messages are still stored in DB and delivered via WebSocket, but push notifications won't fire. Username resolution RPC calls will fail (cached results used where available).
- **notification-service**: Queue consumption paused until reconnection.

### 4. WebSocket Connections Dropping

**Symptoms**: Users report "disconnected" status, reconnection loops, or messages not appearing in real-time.

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
1. Check NGINX `proxy_read_timeout` (should be ≥ 120s for WebSocket).
2. Check if chat-service is OOM: `docker stats --no-stream chat-app-chat-service-1`
3. If memory leak suspected: rolling restart `docker compose restart chat-service`

### 5. Notification Emails Not Sending

**Symptoms**: Users not receiving registration or message notification emails.

**Diagnosis**:
```bash
# Check notification-service logs
docker logs --tail 100 chat-app-notification-service-1 | grep -i "email\|smtp\|sendinblue"

# Check RabbitMQ queue depth (messages piling up = consumer stuck)
docker exec chat-app-rabbitmq-1 rabbitmqctl list_queues name messages consumers
```

**Resolution**:
1. If queue depth is growing: check consumer logs for errors
2. If SMTP timeout: verify `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` env vars
3. If SendinBlue API errors: check `SENDINBLUE_APIKEY` validity and rate limits
4. If messages are malformed: check `NOTIFICATIONS` queue for stuck messages
5. **Purge stuck messages**: `node notification-service/scripts/purgeQueue.js`

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

## Escalation

If an incident is not resolved within 15 minutes:
1. Check all service health endpoints and compile failing checks.
2. Collect logs from all containers: `docker compose logs --tail 200 > incident_logs.txt`
3. Check system resources: `docker stats --no-stream > resource_snapshot.txt`
4. Escalate with both files attached.
