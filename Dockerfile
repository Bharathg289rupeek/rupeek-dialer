# ---- Stage 1: Build Dashboard ----
FROM node:20-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install
COPY dashboard/ .
RUN npm run build

# ---- Stage 2: Production API ----
FROM node:20-alpine AS production
WORKDIR /app

# Install API dependencies
COPY api/package.json api/package-lock.json* ./api/
RUN cd api && npm install --production

# Copy API source
COPY api/src/ ./api/src/
COPY api/.env.example ./api/.env.example
COPY shared/ ./shared/

# Copy built dashboard
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start server
CMD ["node", "api/src/server.js"]
