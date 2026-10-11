##############################################################################
# Environment-aware nginx configuration
# 
# Build args:
#   NGINX_ENV=development (default) - Uses nginx.conf (HTTP only, no SSL)
#   NGINX_ENV=production            - Uses ssl/nginx-ssl.conf (HTTPS with Let's Encrypt)
#
# Usage:
#   Local dev:  docker compose up (uses default development config)
#   Production: docker compose -f docker-compose.yml -f docker-compose.prod.yml up
#               OR: docker build --build-arg NGINX_ENV=production ./nginx
##############################################################################

FROM nginxinc/nginx-unprivileged:stable-alpine-slim@sha256:3af0c10d960cc2502427fe1219c52989d309e7d65596869c60a34fd2fa2406f0

# OCI Image Labels for traceability and security compliance
LABEL org.opencontainers.image.title="Nginx Reverse Proxy" \
      org.opencontainers.image.description="Nginx reverse proxy with SSL termination" \
      org.opencontainers.image.vendor="Chat App" \
      org.opencontainers.image.source="https://github.com/christiantroyandrada/chat-microservices" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="nginxinc/nginx-unprivileged:stable-alpine-slim"

# Build argument to select environment (development or production)
ARG NGINX_ENV=development

# Copy both config files
USER root

# Keep the existing VPS bind-mount path and UID; only nginx's writable cache changes owner.
RUN mkdir -p /opt/bitnami/nginx/conf /var/www/certbot /etc/letsencrypt \
    && chown -R 1001:0 /var/cache/nginx /var/www/certbot /etc/letsencrypt \
    && ln -sf /opt/bitnami/nginx/conf/nginx.conf /etc/nginx/nginx.conf

# Copy the appropriate config based on environment
COPY nginx.conf /opt/bitnami/nginx/conf/nginx.dev.conf
COPY ssl/nginx-ssl.conf /opt/bitnami/nginx/conf/nginx.prod.conf

# Select the right config based on NGINX_ENV
RUN if [ "$NGINX_ENV" = "production" ]; then \
      echo "📦 Using PRODUCTION nginx config (SSL enabled)"; \
      cp /opt/bitnami/nginx/conf/nginx.prod.conf /opt/bitnami/nginx/conf/nginx.conf; \
    else \
      echo "🔧 Using DEVELOPMENT nginx config (HTTP only)"; \
      cp /opt/bitnami/nginx/conf/nginx.dev.conf /opt/bitnami/nginx/conf/nginx.conf; \
    fi

# Expose HTTP and HTTPS ports (non-root)
EXPOSE 8080 8443

USER 1001

# Static configuration needs no vendor templating entrypoint; the PID must be non-root writable.
ENTRYPOINT ["nginx"]
CMD ["-c", "/opt/bitnami/nginx/conf/nginx.conf", "-g", "daemon off; pid /tmp/nginx.pid;"]
