# Hosts the reel website/API with everything installed.
#   docker build -t reel .
#   docker run -p 4317:4317 -v "$PWD:/work" -e REEL_TOKEN=secret -e PEXELS_API_KEY=... reel
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3-venv git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN [ -f vendor/hook-gen/index.html ] || (rm -rf vendor/hook-gen && git clone --depth 1 https://github.com/ddeonmadeit/hook-gen vendor/hook-gen)
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir faster-whisper \
 && .venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')"
RUN ln -s /app/bin/reel.js /usr/local/bin/reel

WORKDIR /work
EXPOSE 4317
CMD ["reel", "serve", "--host", "0.0.0.0"]
