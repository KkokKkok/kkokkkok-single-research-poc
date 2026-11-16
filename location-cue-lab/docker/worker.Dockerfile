# One model worker. KIND chooses which: ocr (PaddleOCR) or grounding (Grounding DINO).
# The two are separate images because their requirements (paddle, torch) are large and unrelated.
#   docker compose build ocr grounding
FROM python:3.11-slim
ARG KIND
# Set for grounding in compose.yaml so pip takes the CPU-only torch wheels (much smaller than the CUDA ones).
ARG PIP_EXTRA_INDEX_URL=

# Shared libraries OpenCV and Paddle load at import time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY scripts/${KIND}-requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
# compose.yaml mounts ./scripts over this copy, so editing a script needs a restart, not a rebuild.
COPY scripts/ocr.py scripts/detect.py scripts/worker-server.py ./scripts/

# Model weights download on first use into the /models volume and stay there.
ENV KIND=${KIND} \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HOME=/models \
    HF_HOME=/models/huggingface HF_HUB_DISABLE_TELEMETRY=1 \
    MODELSCOPE_CACHE=/models/modelscope \
    PADDLE_PDX_CACHE_HOME=/models PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
EXPOSE 8000
CMD ["sh", "-c", "exec python -B -X utf8 scripts/worker-server.py \"$KIND\" --host 0.0.0.0 --port 8000"]
