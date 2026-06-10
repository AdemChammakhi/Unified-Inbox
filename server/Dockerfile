# Backend Dockerfile — hardened
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:24-alpine

# Security: upgrade vulnerable packages and add non-root user
RUN apk upgrade --no-cache libxml2 && \
    addgroup -g 1001 appgroup && adduser -u 1001 -G appgroup -s /bin/sh -D appuser

WORKDIR /app

# Copy deps from build stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/

# Own everything by non-root user
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/ || exit 1

CMD ["node", "server/index.js"]
