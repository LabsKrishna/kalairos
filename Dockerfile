FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# The server binds loopback by default; a container must listen on all interfaces.
ENV KALAIROS_HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
