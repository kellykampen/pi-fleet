FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gnupg \
        procps \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (npm included).
RUN bash -o pipefail -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -" \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI.
RUN mkdir -p -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Fleet worker CLIs.
RUN npm install -g \
        @earendil-works/pi-coding-agent \
        @ai-outfitter/outfitter \
    && npm cache clean --force

RUN mkdir -p /work \
    && node --version \
    && git --version \
    && gh --version \
    && pi --version \
    && outfitter --version

WORKDIR /work
CMD ["sleep", "infinity"]
