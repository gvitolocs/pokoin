# Pokoin card recognition (YOLO detect + Milo CNN embed) — CPU build for the Pi.
# The Pi API (/api/scan-identify) prefers the nezopt GPU worker and falls
# back to this container. Models and catalogs are mounted from /srv/pokoin/scan.
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY app.py catalogs.py card_quad.py __init__.py /app/server/
ENV CARDSCAN_ROOT=/app CARDSCAN_MODELS=/app/models CARDSCAN_CATALOGS=/app/catalogs \
    CARDSCAN_THREADS=2 CARDSCAN_WORKER=pi
EXPOSE 8000
CMD ["uvicorn", "app:app", "--app-dir", "/app/server", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
