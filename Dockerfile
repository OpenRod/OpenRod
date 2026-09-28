FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# curl/ca-certificates for the installer, git for Claude Code,
# iproute2 for OpenShell's sandbox networking
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates curl git iproute2 \
    && rm -rf /var/lib/apt/lists/*

# OpenShell expects a non-root "sandbox" user
RUN useradd --create-home --home-dir /sandbox --shell /bin/bash sandbox

# Install Claude Code and place the real binary at /usr/local/bin/claude,
# the path OpenShell's claude-code provider profile allows to reach Anthropic
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp -L /root/.local/bin/claude /usr/local/bin/claude \
    && chmod 0755 /usr/local/bin/claude \
    && rm -rf /root/.local /root/.claude* \
    && claude --version

# Web Search runs on Anthropic's servers, so OpenShell's egress rules can't see
# or limit it. Deny it for every user; Web Fetch still works, and runs inside
# the sandbox where egress rules decide which sites it may reach.
RUN mkdir -p /etc/claude-code \
    && printf '{"permissions":{"deny":["WebSearch"]}}\n' > /etc/claude-code/managed-settings.json

ENV HOME=/sandbox
ENV DISABLE_AUTOUPDATER=1

USER sandbox
WORKDIR /sandbox
