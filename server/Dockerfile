# Backend Dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy root package.json and install dependencies
COPY package.json ./
RUN npm install --production

# Copy server source code
COPY . .

EXPOSE 5000

CMD ["node", "server/index.js"]
