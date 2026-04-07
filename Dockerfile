FROM ubuntu:24.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git gcc python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Copy and compile the enforcement engine at build time
COPY loader /loader
RUN gcc -O2 -o /loader/git_gate /loader/git_gate.c && \
    chmod +x /loader/git_gate && \
    chmod +x /loader/load_git_gate.py

WORKDIR /workspace

# The Python loader acts as a transparent git wrapper
ENTRYPOINT ["python3", "/loader/load_git_gate.py"]
