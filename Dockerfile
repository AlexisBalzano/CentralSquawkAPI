# Build stage: compile TypeScript with dev dependencies present.
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage.
FROM node:22-alpine

# git is needed at runtime, not just at build: the config webhook pulls the
# config repository in place inside the /app/data volume.
RUN apk add --no-cache git

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY scripts/init-config.sh /app/init-config.sh
RUN chmod +x /app/init-config.sh

# The config repository is checked out here and persists across restarts, so a
# restart does not have to re-clone before it can serve.
VOLUME ["/app/data"]

EXPOSE 3000

# Fetch config first, then start. Without config there is nothing to serve, so
# a failed fetch must stop the container rather than start an empty one.
CMD ["/app/init-config.sh"]
