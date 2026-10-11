# Match the builder libc to the production runtime.
FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS builder

# OCI Image Labels for traceability and security compliance
# These labels follow the OCI Image Spec annotations
LABEL org.opencontainers.image.title="Chat Service" \
      org.opencontainers.image.description="Real-time chat microservice" \
      org.opencontainers.image.vendor="Chat App" \
      org.opencontainers.image.source="https://github.com/christiantroyandrada/chat-microservices" \
      org.opencontainers.image.documentation="https://github.com/christiantroyandrada/chat-microservices/blob/main/README.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs22-debian13:nonroot"

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
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c

WORKDIR /usr/src/app

# Copy built application and production node_modules from the builder
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./

EXPOSE 8082

# Distroless images set the node binary as the ENTRYPOINT. Provide the script
# path only so the binary receives the correct arg list (no duplicated 'node').
CMD ["build/src/server.js"]
