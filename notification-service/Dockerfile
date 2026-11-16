# Builder stage: use a Debian-slim Node image for predictable toolchain
FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS builder

# OCI Image Labels for traceability and security compliance
LABEL org.opencontainers.image.title="Notification Service" \
      org.opencontainers.image.description="Email and push notification microservice" \
      org.opencontainers.image.vendor="Chat App" \
      org.opencontainers.image.source="https://github.com/christiantroyandrada/chat-microservices" \
      org.opencontainers.image.documentation="https://github.com/christiantroyandrada/chat-microservices/blob/main/README.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs22-debian13:nonroot"

WORKDIR /usr/src/app

# Copy package files and install all dependencies (including devDeps needed for build)
COPY package*.json ./
# Update OS packages in the build stage to reduce known vulnerabilities
RUN apt-get update \
	&& apt-get upgrade -y \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove devDependencies to keep final image small
RUN npm prune --production

# Final stage: use latest pinned distroless Node runtime (nonroot)
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:39c66687298417dbf3ff2fb8b6012c20554494e16414ef7afd07b9abbb45b501

WORKDIR /usr/src/app

# Copy built app and production node_modules from the builder
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./
# Ensure template files are available in the runtime image at the same
# relative location the app expects (build/src/templates)
COPY --from=builder /usr/src/app/src/templates ./build/src/templates

EXPOSE 8083

# Distroless images set the node binary as the ENTRYPOINT. Provide the script
# path only so the binary receives the correct arg list (no duplicated 'node').
CMD ["build/src/server.js"]
