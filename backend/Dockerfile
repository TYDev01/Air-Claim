# ─── Stage 1: builder ────────────────────────────────────────────────────────
# Installs all dependencies (dev included) and compiles TypeScript to dist/.
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifest files first — layer is cached unless deps change.
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install all dependencies including devDependencies (needed for tsc).
RUN npm ci --ignore-scripts

# Generate Prisma client before compiling (client types are imported by src/).
RUN npx prisma generate

# Copy source and compile.
COPY tsconfig.json ./
COPY src ./src/
COPY abis ./abis/

RUN npm run build

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
# Lean image — only production dependencies and compiled output.
FROM node:20-alpine AS runtime

# Create a non-root user and group.
RUN addgroup -S oracle && adduser -S oracle -G oracle

WORKDIR /app

# Copy manifest files for production install.
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install production dependencies only.
RUN npm ci --omit=dev --ignore-scripts

# Generate Prisma client in the production image.
RUN npx prisma generate

# Copy compiled output and ABI files from the builder stage.
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/abis ./abis/

# Transfer ownership of the app directory to the non-root user.
RUN chown -R oracle:oracle /app

USER oracle

# Expose the HTTP server port (overridable via HTTP_PORT env var).
EXPOSE 3000

# Health check — queries /healthz every 30 s.
# Starts checking 20 s after container start to allow DB migration time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

# Entrypoint: run Prisma migration then start the oracle process.
# Migration is idempotent — safe to run on every container start.
# Uses sh -c so signals (SIGTERM) are forwarded to the node process.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
