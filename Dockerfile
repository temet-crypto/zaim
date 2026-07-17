# ═══════════════════════════════════════════════════════════
# ZAIM — Multi-stage Dockerfile
# Stage 1: Build React + WASM app
# Stage 2: Serve static files with Nginx
# ═══════════════════════════════════════════════════════════

# ── Build Stage ──
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy source
COPY . .

# Build for production
RUN npm run build

# ── Production Stage ──
FROM nginx:alpine

# Copy built static files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config
COPY nginx/zaim.conf /etc/nginx/conf.d/default.conf

# Required headers for SharedArrayBuffer (WebZjs thread pool)
# These MUST be present or WASM multi-threading will fail
RUN echo 'add_header Cross-Origin-Opener-Policy "same-origin" always;' >> /etc/nginx/conf.d/headers.conf && \
    echo 'add_header Cross-Origin-Embedder-Policy "require-corp" always;' >> /etc/nginx/conf.d/headers.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
