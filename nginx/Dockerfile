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

FROM bitnami/nginx@sha256:ca82b8a08e8e0e73aac438f43c66ce8d966988f0adb0589df3e34c7514adb4ea

# Build argument to select environment (development or production)
ARG NGINX_ENV=development

# Copy both config files
USER root
RUN rm -f /opt/bitnami/nginx/conf/nginx.conf || true

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

# Create directories for Let's Encrypt and ACME challenges
RUN mkdir -p /var/www/certbot /etc/letsencrypt && \
    chown -R 1001:1001 /var/www/certbot /etc/letsencrypt

# Expose HTTP and HTTPS ports (non-root)
EXPOSE 8080 8443

# Bitnami images run as a non-root user (1001) by default
USER 1001
