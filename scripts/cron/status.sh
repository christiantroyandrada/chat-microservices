#!/bin/bash
# Status Check Script - Shows health and security status
# Run manually: /opt/chat-app/scripts/cron/status.sh

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        CHAT APP SERVER HEALTH & SECURITY STATUS                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "📅 $(date)"
echo ""

echo "═══ SYSTEM HEALTH ═══"
echo "CPU Load: $(uptime | awk -F'load average:' '{print $2}')"
echo "Memory:   $(free -h | awk '/Mem:/ {printf "%s used / %s total (%.1f%%)\n", $3, $2, $3/$2*100}')"
echo "Disk:     $(df -h / | awk 'NR==2 {printf "%s used / %s total (%s)\n", $3, $2, $5}')"
echo "Uptime:   $(uptime -p)"
echo ""

echo "═══ DOCKER CONTAINERS ═══"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null | head -10
echo ""

echo "═══ SECURITY STATUS ═══"
echo "🔥 Firewall (UFW):"
sudo ufw status | head -5
echo ""

echo "🛡️  Fail2Ban:"
sudo fail2ban-client status sshd 2>/dev/null | grep -E "Currently|Total" || echo "   Not running"
echo ""

echo "🔒 SSL Certificate:"
CERT_PATH="/opt/chat-app/chat-microservices/certbot/conf/live"
for domain_dir in "$CERT_PATH"/*/; do
    if [ -f "${domain_dir}cert.pem" ]; then
        DOMAIN=$(basename "$domain_dir")
        EXPIRY=$(openssl x509 -enddate -noout -in "${domain_dir}cert.pem" 2>/dev/null | cut -d= -f2)
        echo "   $DOMAIN expires: $EXPIRY"
    fi
done
echo ""

echo "═══ RECENT ALERTS ═══"
if [ -f /var/log/chat-app/alerts.log ]; then
    echo "Last 5 alerts:"
    tail -5 /var/log/chat-app/alerts.log 2>/dev/null || echo "   No alerts"
else
    echo "   No alerts file found"
fi
echo ""

echo "═══ CRON JOBS ═══"
echo "Active cron jobs: $(crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l)"
crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | awk '{print "   " $6 " - " $7}'
echo ""

echo "═══ LATEST BACKUP ═══"
if [ -L /opt/chat-app/backups/postgres/latest.sql.gz ]; then
    BACKUP_FILE=$(readlink -f /opt/chat-app/backups/postgres/latest.sql.gz)
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    BACKUP_DATE=$(stat -c %y "$BACKUP_FILE" | cut -d'.' -f1)
    echo "   File: $(basename $BACKUP_FILE)"
    echo "   Size: $BACKUP_SIZE"
    echo "   Date: $BACKUP_DATE"
else
    echo "   No backups found"
fi
echo ""

echo "═══ LOG FILES ═══"
ls -lh /var/log/chat-app/*.log 2>/dev/null | awk '{print "   " $9 " (" $5 ")"}'
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "✅ Server health and security monitoring is active!"
echo "════════════════════════════════════════════════════════════════"
