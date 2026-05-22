# Stage 1: Build the application
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for build tools)
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy application source files
COPY . .

# Build NestJS app
RUN npm run build

# ---
# Stage 2: Production release
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install only production dependencies (now includes prisma package)
RUN npm ci --only=production && npm cache clean --force

# Generate Prisma Client for production environment
RUN npx prisma generate

# Copy build output from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Create upload directory in the container
RUN mkdir -p uploads

# Expose NestJS port (default 4000)
EXPOSE 4000

# Set entrypoint to run migrations and start the NestJS application
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
