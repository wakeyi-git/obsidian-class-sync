FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV HOST=0.0.0.0 PORT=1234 YPERSISTENCE=/data
EXPOSE 1234
CMD ["node", "server.js"]