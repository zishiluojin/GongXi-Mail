# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# 安装服务端依赖：使用 package-lock 进行更稳定的 CI 安装，并增加网络重试配置，降低弱网下 ECONNRESET 概率。
COPY server/package*.json ./server/
RUN cd server \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set registry https://registry.npmjs.org/ \
    && npm ci --no-audit --prefer-online

# 安装前端依赖：同样增加重试，避免构建阶段因网络抖动失败。
COPY web/package*.json ./web/
RUN cd web \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set registry https://registry.npmjs.org/ \
    && npm ci --legacy-peer-deps --no-audit --prefer-online

# Copy source code
COPY server ./server
COPY web ./web

# Generate Prisma client
RUN cd server && npx prisma generate

# Build server
RUN cd server && npm run build

# Build frontend
RUN cd web && npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy server
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/prisma ./server/prisma

# Copy frontend build to public
COPY --from=builder /app/web/dist ./public

# Set working directory to server
WORKDIR /app/server

# Run database migrations and start server
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]

EXPOSE 3000
