FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite

FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

FROM base AS final
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p logs data && \
    addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD wget -qO- http://localhost:5000/api/health || exit 1

CMD ["node", "src/server.js"]
