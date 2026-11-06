# Probe image for issue #5 (see surfaces/vscode/CLAUDE-CODE.md): a Debian (glibc)
# x86_64 userland with openvscode-server and the Claude Code extension, native
# binary included, unpacked where the server finds it. Boots only on the x86_64
# machine. build.sh downloads the two archives into downloads/ (gitignored).
#
# Node doesn't run under the build's qemu-user (SIGSEGV), so the .vsix is
# unzipped into the extensions folder instead of `--install-extension`.
ARG BASE=debian:bookworm-slim
FROM --platform=linux/amd64 ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git procps iproute2 curl less nano python3 libatomic1 unzip \
    && rm -rf /var/lib/apt/lists/* /core

ARG OPENVSCODE_VERSION
ADD downloads/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz /opt/
RUN mv /opt/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64 /opt/openvscode-server \
    && ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server

ARG CLAUDE_CODE_VERSION
COPY downloads/claude-code-${CLAUDE_CODE_VERSION}-linux-x64.vsix /tmp/claude.vsix
RUN mkdir -p /root/.openvscode-server/extensions /tmp/x && cd /tmp/x \
    && unzip -q /tmp/claude.vsix 'extension/*' \
    && mv extension /root/.openvscode-server/extensions/anthropic.claude-code-${CLAUDE_CODE_VERSION} \
    && chmod 755 /root/.openvscode-server/extensions/anthropic.claude-code-${CLAUDE_CODE_VERSION}/resources/native-binary/claude \
    && ln -s /root/.openvscode-server/extensions/anthropic.claude-code-${CLAUDE_CODE_VERSION}/resources/native-binary/claude /usr/local/bin/claude \
    && rm -rf /tmp/claude.vsix /tmp/x /core

# The runtime's guest half, the welcome project and the CA settings: as images/base/Dockerfile.
COPY --from=guest vm-init  /sbin/vm-init
COPY --from=guest vm-agent /sbin/vm-agent
COPY --from=base welcome/  /root/project/
COPY --from=base overlay/  /
RUN chmod 755 /sbin/vm-init /sbin/vm-agent /root/project/hello.sh && rm -f /core
