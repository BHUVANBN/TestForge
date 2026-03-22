FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

RUN apk add --no-cache bash curl && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

RUN npm ci

# Copy source code
COPY . .

# Create necessary directories
RUN mkdir -p logs/jobs temp

# Build the application
RUN npm run build


FROM node:18-alpine AS runner

WORKDIR /app

RUN apk add --no-cache bash curl && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and runtime files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.env.example ./.env.example
COPY --from=builder /app/README.md ./README.md

# Create necessary directories
RUN mkdir -p logs/jobs temp && \
    chown -R nodejs:nodejs logs temp

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/api/v1/health || exit 1

# Start the application
CMD ["npm", "start"]
