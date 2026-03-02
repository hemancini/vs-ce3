# ── Stage 1: compilar mp4decrypt (Bento4) desde source ──────────────────────
FROM alpine:3.20 AS bento4-builder

RUN apk add --no-cache cmake g++ make curl
RUN curl -sL "https://github.com/axiomatic-systems/Bento4/archive/refs/tags/v1.6.0-641.tar.gz" \
      -o /tmp/bento4.tar.gz \
    && tar xzf /tmp/bento4.tar.gz -C /tmp \
    && cd /tmp/Bento4-1.6.0-641 \
    && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && make -j$(nproc) mp4decrypt \
    && cp mp4decrypt /usr/local/bin/mp4decrypt

# ── Stage 2: imagen final liviana ───────────────────────────────────────────
FROM node:22-alpine

# Instalar runtime: python3, pip, ffmpeg
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages \
        pywidevine==1.9.0 \
        construct==2.8.8

# Copiar mp4decrypt compilado
COPY --from=bento4-builder /usr/local/bin/mp4decrypt /usr/local/bin/mp4decrypt

# Directorio de trabajo
WORKDIR /app

# Copiar scripts
COPY scripts/download-video.mjs scripts/download-video.mjs
COPY scripts/get-widevine-keys.py scripts/get-widevine-keys.py

# device.wvd se monta en runtime: -v ./device.wvd:/app/device.wvd

# Directorio de descargas (montar volumen aquí)
RUN mkdir -p /app/downloads
VOLUME /app/downloads

ENTRYPOINT ["node", "scripts/download-video.mjs"]
