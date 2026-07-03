FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.mjs ./
COPY lib ./lib
COPY bots ./bots
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
CMD ["node", "index.mjs"]
