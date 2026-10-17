FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node .dockerignore .env.example ./
RUN mkdir -p /app/state && chown node:node /app/state
USER node
ENV NODE_OPTIONS=--max-old-space-size=128
RUN npm test
CMD ["node","src/main.ts"]
