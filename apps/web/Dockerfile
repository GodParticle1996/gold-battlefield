# GOLD BATTLEFIELD — web (Vite build → nginx)
# Build context: repository root (see docker-compose.yml).
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN npm ci --no-audit --no-fund

# The worker connects to the nginx /ws proxy. The compose mapping exposes the
# web service on host port 8080, so the default must match (port 80 is NOT
# published). Override with --build-arg VITE_GATEWAY_URL=wss://your.host/ws in
# real deployments.
ARG VITE_GATEWAY_URL=ws://localhost:8080/ws
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL

RUN npm run build --workspace @gb/web

FROM nginx:1.27-alpine

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
