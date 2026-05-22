# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder

WORKDIR /usr/src/app

ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/bill_analysis?schema=public"

COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm ci

RUN npx prisma generate

COPY . .

RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/package.json ./
COPY --from=builder /usr/src/app/prisma ./prisma
COPY --from=builder /usr/src/app/prisma.config.ts ./

RUN mkdir -p uploads

EXPOSE 4000

CMD ["node", "dist/main.js"]
