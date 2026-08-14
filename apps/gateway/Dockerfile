# GOLD BATTLEFIELD — gateway (Node + tsx)
# Build context: repository root (see docker-compose.yml).
FROM node:20-alpine

WORKDIR /app

# Install workspace dependencies (all packages are TypeScript source; tsx runs them).
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
# Replay fixtures are required by the gateway's defaultFixturePath() resolution
# (otherwise replay mode would silently fall back to simulation in the image).
COPY tests/fixtures ./tests/fixtures

RUN npm ci --no-audit --no-fund

EXPOSE 8081

CMD ["npm", "run", "start", "--workspace", "@gb/gateway"]
