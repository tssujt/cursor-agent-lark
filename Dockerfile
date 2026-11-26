FROM oven/bun:1.4.5-alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080
CMD ["bun", "src/index.ts"]
