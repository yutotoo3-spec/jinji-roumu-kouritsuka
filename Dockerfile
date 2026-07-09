FROM node:22-alpine

WORKDIR /app
COPY package.json server.js template.json ./
COPY lib ./lib
COPY public ./public

# データは /data に永続化する（ホスティングのボリュームをここにマウント）
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
