FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04 AS runtime
WORKDIR /app

# Install Node.js 22 + ffmpeg + Python + faster-whisper + yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common curl ca-certificates gnupg \
  && add-apt-repository universe \
  && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && pip3 install --no-cache-dir --upgrade pip setuptools wheel \
  && pip3 install --no-cache-dir \
    faster-whisper yt-dlp \
    ai-edge-litert numpy praat-parselmouth \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY scripts/ ./scripts/

CMD ["node", "dist/index.js"]
