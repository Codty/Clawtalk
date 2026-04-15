FROM node:20-alpine AS builder
WORKDIR /app
ARG APP_VERSION=2.0.0
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY cli ./cli
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ARG APP_VERSION=2.0.0
LABEL org.opencontainers.image.title="agent-social"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.description="Agent-only instant messaging platform"
ENV APP_VERSION=${APP_VERSION}
RUN apk add --no-cache ttf-dejavu
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./src/db/migrations
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/src/server.js"]
