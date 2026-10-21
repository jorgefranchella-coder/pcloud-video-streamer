# Build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# Production stage
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nodejs && mkdir /data && chown nodejs:nodejs /data

# Copy built dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs indexer.js metadata-store.js ./
COPY --chown=nodejs:nodejs visual-analyzer.js ./
COPY --chown=nodejs:nodejs config.js ./
COPY --chown=nodejs:nodejs public ./public
COPY --chown=nodejs:nodejs scripts ./scripts
COPY --chown=nodejs:nodejs package*.json ./

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV VIDEO_ROOT="/mnt/pcloud/My Videos"
ENV DATA_DIR=/data

CMD ["node", "server.js"]
