#!/bin/bash
# System Metrics Collection Script
# Runs every 10 minutes - collects metrics for monitoring

set -e

METRICS_DIR="/var/log/chat-app/metrics"
METRICS_FILE="$METRICS_DIR/metrics_$(date '+%Y%m%d').json"
TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%SZ')

mkdir -p "$METRICS_DIR"

# Collect system metrics
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
MEM_TOTAL=$(free -m | awk '/Mem:/ {print $2}')
MEM_USED=$(free -m | awk '/Mem:/ {print $3}')
MEM_PERCENT=$(echo "scale=1; $MEM_USED * 100 / $MEM_TOTAL" | bc)
DISK_PERCENT=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
LOAD_1=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}' | tr -d ' ')
LOAD_5=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $2}' | tr -d ' ')
LOAD_15=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $3}' | tr -d ' ')
UPTIME_SECONDS=$(cat /proc/uptime | cut -d' ' -f1 | cut -d'.' -f1)

# Collect Docker metrics
CONTAINERS_RUNNING=$(docker ps -q 2>/dev/null | wc -l)
CONTAINERS_TOTAL=$(docker ps -aq 2>/dev/null | wc -l)
CONTAINERS_HEALTHY=$(docker ps --filter "health=healthy" -q 2>/dev/null | wc -l)
CONTAINERS_UNHEALTHY=$(docker ps --filter "health=unhealthy" -q 2>/dev/null | wc -l)

# Network connections
ESTABLISHED_CONNECTIONS=$(ss -tn state established 2>/dev/null | wc -l)
LISTENING_PORTS=$(ss -tln 2>/dev/null | wc -l)

# Write metrics as JSON line
cat >> "$METRICS_FILE" << METRIC
{"timestamp":"$TIMESTAMP","cpu_percent":$CPU_USAGE,"memory_percent":$MEM_PERCENT,"memory_used_mb":$MEM_USED,"memory_total_mb":$MEM_TOTAL,"disk_percent":$DISK_PERCENT,"load_1min":$LOAD_1,"load_5min":$LOAD_5,"load_15min":$LOAD_15,"uptime_seconds":$UPTIME_SECONDS,"containers_running":$CONTAINERS_RUNNING,"containers_total":$CONTAINERS_TOTAL,"containers_healthy":$CONTAINERS_HEALTHY,"containers_unhealthy":$CONTAINERS_UNHEALTHY,"connections_established":$ESTABLISHED_CONNECTIONS,"listening_ports":$LISTENING_PORTS}
METRIC

# Cleanup old metrics files (keep 7 days)
find "$METRICS_DIR" -name "metrics_*.json" -mtime +7 -delete 2>/dev/null || true

# Generate daily summary at midnight
HOUR=$(date '+%H')
if [ "$HOUR" = "00" ]; then
    YESTERDAY=$(date -d 'yesterday' '+%Y%m%d')
    YESTERDAY_FILE="$METRICS_DIR/metrics_${YESTERDAY}.json"
    SUMMARY_FILE="$METRICS_DIR/summary_${YESTERDAY}.txt"
    
    if [ -f "$YESTERDAY_FILE" ]; then
        echo "Daily Summary for $YESTERDAY" > "$SUMMARY_FILE"
        echo "==============================" >> "$SUMMARY_FILE"
        echo "Total samples: $(wc -l < "$YESTERDAY_FILE")" >> "$SUMMARY_FILE"
        
        # Calculate averages using jq if available
        if command -v jq &> /dev/null; then
            AVG_CPU=$(jq -s 'add / length | .cpu_percent' "$YESTERDAY_FILE" 2>/dev/null || echo "N/A")
            AVG_MEM=$(jq -s 'add / length | .memory_percent' "$YESTERDAY_FILE" 2>/dev/null || echo "N/A")
            echo "Average CPU: $AVG_CPU%" >> "$SUMMARY_FILE"
            echo "Average Memory: $AVG_MEM%" >> "$SUMMARY_FILE"
        fi
    fi
fi
