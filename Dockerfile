FROM node:20-slim

WORKDIR /app

# Install system deps + Playwright browsers in one layer
COPY package*.json ./
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    fonts-liberation libgl1 libegl1 libgles2 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install \
    && npx playwright install --with-deps chromium

COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
