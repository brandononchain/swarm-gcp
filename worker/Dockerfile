# Small, non root, no build step. Cloud Run jobs start this image, run one
# pass, and exit.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
USER node
CMD ["node", "src/index.js"]
