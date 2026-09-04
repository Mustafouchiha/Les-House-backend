# syntax=docker/dockerfile:1
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY . .
# postinstall runs: prisma generate + tsc -> dist/
RUN npm install --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
EXPOSE 8080
# Apply migrations on boot, then start the API (bot starts too if BOT_TOKEN is set).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
