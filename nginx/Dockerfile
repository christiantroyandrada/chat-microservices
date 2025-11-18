##############################################################################
# Use a vendor-maintained, security-focused nginx image (Bitnami) as a quick
# remedial option: rebuild and re-scan to compare CVEs.
##############################################################################

FROM bitnami/nginx@sha256:8fed12f41a27a2be67125d0e063aab7a07687aab12c193eac63d8346ba72925e

# Replace the default nginx config with our pinned config
USER root
RUN rm -f /opt/bitnami/nginx/conf/nginx.conf || true
COPY nginx.conf /opt/bitnami/nginx/conf/nginx.conf

# Expose the internal non-root port used by this project
EXPOSE 8080

# Bitnami images run as a non-root user (1001) by default
USER 1001
