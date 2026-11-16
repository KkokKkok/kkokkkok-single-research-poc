# Web server and pipeline. Build from location-cue-lab:  docker compose build api
FROM node:24-slim

# The OCR contact sheets print each region's ID with an SVG <text> in Arial. Without a font in the image
# those labels render empty and the model cannot tell the crops apart. Liberation Sans stands in for Arial.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# Records and analysis images live in the /data volume, never in the image.
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=3210 CUE_DATA_DIR=/data
USER node
EXPOSE 3210
CMD ["node", "server.mjs"]
