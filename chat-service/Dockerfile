# Build stage — use Debian 12 (bookworm) for better security updates
FROM node:22-bookworm-slim AS builder

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install OS updates and dependencies (including devDependencies for build)
# Keeping this in the builder stage allows picking up OS-level security fixes
RUN apt-get update \
	&& apt-get upgrade -y \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm ci \
	&& npm cache clean --force

# Copy source code
COPY . .

# Build the application and remove devDependencies to keep artifacts small
RUN npm run build \
	&& npm prune --production \
	&& rm -rf /root/.npm /tmp/*

# Production stage - use latest pinned distroless image
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:1014312994b734e9f3bba23bb96fab389119750a98f14bc76936dc2a7e72c3da

WORKDIR /usr/src/app

# Copy built application and production node_modules from the builder
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./

EXPOSE 8082

# Distroless images set the node binary as the ENTRYPOINT. Provide the script
# path only so the binary receives the correct arg list (no duplicated 'node').
CMD ["build/src/server.js"]
