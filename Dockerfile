# Render.com Compatible Dockerfile for WhatsApp Automation
# Chrome is pre-installed - no Puppeteer download needed
FROM node:20-slim

# Install Chrome dependencies for Puppeteer (as root)
RUN apt-get update \
    && apt-get install -y wget gnupg ca-certificates curl \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y \
        google-chrome-stable \
        fonts-ipafont-gothic \
        fonts-wqy-zenhei \
        fonts-thai-tlwg \
        fonts-kacst \
        fonts-freefont-ttf \
        libxss1 \
        dumb-init \
        --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Set environment variables - Chrome is at /usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Create directories for sessions and logs
RUN mkdir -p wa-sessions-temp sessions logs

# Expose port (Render provides PORT env var)
EXPOSE 10000

# Use dumb-init for proper signal handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the application
CMD ["node", "--expose-gc", "--max-old-space-size=384", "index.js"]
