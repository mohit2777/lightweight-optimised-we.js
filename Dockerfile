# Optimized Dockerfile for WhatsApp Multi-Automation
# Minimal footprint, low RAM usage

FROM node:18-slim AS base

# Install Chromium and minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-freefont-ttf \
    libxss1 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/*

# Environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=256" \
    PORT=7860

# Create non-root user for security
RUN groupadd -r appgroup && useradd -r -g appgroup appuser

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copy application source
COPY --chown=appuser:appgroup . .

# Create temp directories with proper permissions
RUN mkdir -p wa-sessions-temp logs sessions \
    && chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

EXPOSE 7860

# Use dumb-init for proper signal handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
