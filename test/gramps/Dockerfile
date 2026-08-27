FROM debian:trixie-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gramps \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
