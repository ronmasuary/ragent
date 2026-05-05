FROM node:22-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY tsconfig.json ./
CMD ["npx", "tsx", "src/index.ts"]
