#!/bin/bash
# Health Check Script - Monitors Docker services and system health
# Runs every 5 minutes

set -e

LOG_FILE="/var/log/chat-app/health-check.log"
ALERT_FILE="/var/log/chat-app/alerts.log"
PROJECT_DIR="/opt/chat-app/chat-microservices"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Services to monitor
SERVICES=("user" "chat" "notification" "nginx" "postgres" "frontend")

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

alert() {
    echo "[$TIMESTAMP] ALERT: $1" >> "$ALERT_FILE"
    echo "[$TIMESTAMP] ALERT: $1" >> "$LOG_FILE"
}

# Check if Docker is running
if ! systemctl is-active --quiet docker; then
    alert "Docker daemon is not running! Attempting restart..."
    sudo systemctl restart docker
    sleep 10
fi

# Check each service
cd "$PROJECT_DIR" 2>/dev/null || exit 1

for service in "${SERVICES[@]}"; do
    CONTAINER_NAME="chat-microservices-${service}-1"
    
    # Check if container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        alert "Container $CONTAINER_NAME is not running! Attempting restart..."
        docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d "$service" 2>/dev/null || true
        continue
    fi
    
    # Check container health status
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "none")
    
    if [ "$HEALTH" = "unhealthy" ]; then
        alert "Container $CONTAINER_NAME is unhealthy! Restarting..."
        docker compose -f docker-compose.yml -f docker-compose.prod.yml restart "$service" 2>/dev/null || true
    fi
done

# Check disk space (alert if > 85% used)
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 85 ]; then
    alert "Disk usage is at ${DISK_USAGE}%! Consider cleanup."
fi

# Check memory usage (alert if > 90% used)
MEM_USAGE=$(free | awk '/Mem:/ {printf("%.0f"), $3/$2 * 100}')
if [ "$MEM_USAGE" -gt 90 ]; then
    alert "Memory usage is at ${MEM_USAGE}%! Consider scaling or optimization."
fi

# Check load average
LOAD_1MIN=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}' | tr -d ' ')
CPU_COUNT=$(nproc)
LOAD_THRESHOLD=$(echo "$CPU_COUNT * 2" | bc)
if (( $(echo "$LOAD_1MIN > $LOAD_THRESHOLD" | bc -l) )); then
    alert "High load average: $LOAD_1MIN (threshold: $LOAD_THRESHOLD)"
fi

log "Health check completed. Disk: ${DISK_USAGE}%, Memory: ${MEM_USAGE}%, Load: ${LOAD_1MIN}"
