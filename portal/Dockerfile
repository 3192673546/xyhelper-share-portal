FROM node:24.14.0-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8080

CMD ["node", "src/index.mjs"]
