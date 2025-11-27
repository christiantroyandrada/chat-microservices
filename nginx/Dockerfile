##############################################################################
# Use a vendor-maintained, security-focused nginx image (Bitnami) as a quick
# remedial option: rebuild and re-scan to compare CVEs.
# Updated to latest image (November 2025) to address CVE-2024-10963
##############################################################################

FROM bitnami/nginx@sha256:ca82b8a08e8e0e73aac438f43c66ce8d966988f0adb0589df3e34c7514adb4ea

# Replace the default nginx config with our pinned config
USER root
RUN rm -f /opt/bitnami/nginx/conf/nginx.conf || true
COPY nginx.conf /opt/bitnami/nginx/conf/nginx.conf

# Create directories for Let's Encrypt and ACME challenges
RUN mkdir -p /var/www/certbot /etc/letsencrypt && \
    chown -R 1001:1001 /var/www/certbot /etc/letsencrypt

# Expose HTTP and HTTPS ports (non-root)
EXPOSE 8080 8443

# Bitnami images run as a non-root user (1001) by default
USER 1001
