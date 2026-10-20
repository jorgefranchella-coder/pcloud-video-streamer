# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:20-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs public ./public
COPY --chown=nodejs:nodejs package*.json ./

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV VIDEO_ROOT="/mnt/pcloud/My Videos"

CMD ["node", "server.js"]