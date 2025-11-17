# Build stage — official Node slim pinned to digest (hardened PoC)
FROM node:22-bullseye-slim@sha256:204476c3121ff0222e53b2cdf6f90d5c2997bfbb7f8285ad278ba4555de3a087 AS builder

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for build) and clean cache
RUN npm ci \
	&& npm cache clean --force

# Copy source code
COPY . .

# Build the application and remove devDependencies to keep artifacts small
RUN npm run build \
	&& npm prune --production \
	&& rm -rf /root/.npm /tmp/*

# Production stage
FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /usr/src/app

# Copy built application and production node_modules from the builder
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./

EXPOSE 8082

# Distroless images set the node binary as the ENTRYPOINT. Provide the script
# path only so the binary receives the correct arg list (no duplicated 'node').
CMD ["build/src/server.js"]
