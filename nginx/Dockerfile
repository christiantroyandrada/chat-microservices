FROM nginx:alpine-slim

# Install curl for healthchecks
RUN apk add --no-cache curl

# Create a non-root user and group for nginx (use 1001 to avoid conflicts with existing groups)
RUN addgroup -g 1001 -S nginx-app && adduser -S -D -H -u 1001 -h /var/cache/nginx -s /sbin/nologin -G nginx-app -g nginx-app nginx-app

# Adjust permissions for nginx to run as non-root
RUN touch /var/run/nginx.pid && \
    chown -R nginx-app:nginx-app /var/cache/nginx /var/run/nginx.pid /etc/nginx

RUN rm -f /etc/nginx/nginx.conf

COPY nginx.conf /etc/nginx/nginx.conf

# Switch to non-root user
USER nginx-app

# Expose port (must be > 1024 for non-root, we'll use 8080 internally)
EXPOSE 8080
