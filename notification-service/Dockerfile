# Builder stage: use a Debian-slim Node image for predictable toolchain
FROM node:22-bookworm-slim AS builder

WORKDIR /usr/src/app

# Copy package files and install all dependencies (including devDeps needed for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove devDependencies to keep final image small
RUN npm prune --production

# Final stage: use distroless Node runtime (nonroot)
FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /usr/src/app

# Copy built app and production node_modules from the builder
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./

EXPOSE 8083

# Distroless images set the node binary as the ENTRYPOINT. Provide the script
# path only so the binary receives the correct arg list (no duplicated 'node').
CMD ["build/src/server.js"]
