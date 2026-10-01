FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# git for projects and Claude Code worktrees, iproute2 for OpenShell's
# sandbox networking, ripgrep for both agents' search tools
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates curl git iproute2 ripgrep xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node for Codex's npm package and for projects
ARG NODE_VERSION=22.20.0
RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
        | tar -xJ --strip-components=1 -C /usr/local \
    && node --version

# OpenShell expects a non-root "sandbox" user
RUN useradd --create-home --home-dir /sandbox --shell /bin/bash sandbox

# Claude Code at /usr/local/bin/claude for terminal use. The desktop app
# uploads its own copy to ~/.claude/remote/, which policy.yaml also covers.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp -L /root/.local/bin/claude /usr/local/bin/claude \
    && chmod 0755 /usr/local/bin/claude \
    && rm -rf /root/.local /root/.claude* \
    && claude --version

# Codex under /usr/local/lib/node_modules/@openai/, where policy.yaml allows its
# native binary to connect. The Codex app runs `codex app-server` over SSH and
# expects `codex` on the login shell's PATH.
RUN npm install --global @openai/codex && codex --version

# Web Search runs on Anthropic's servers, outside OpenShell's egress rules
RUN mkdir -p /etc/claude-code \
    && printf '{"permissions":{"deny":["WebSearch"]}}\n' > /etc/claude-code/managed-settings.json

# OpenShell is the sandbox boundary; Codex's own bubblewrap sandbox can't
# create namespaces inside it
COPY --chown=sandbox:sandbox codex-config.toml /sandbox/.codex/config.toml

ENV HOME=/sandbox
ENV DISABLE_AUTOUPDATER=1

USER sandbox
RUN mkdir -p /sandbox/projects
WORKDIR /sandbox
