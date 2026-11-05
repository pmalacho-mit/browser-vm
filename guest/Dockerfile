# The guest userland. This is an ordinary Dockerfile: whatever you put in here
# ends up as the root filesystem of the Linux VM running in the browser.
#
# Requirements:
#   * must match the emulator's CPU: linux/386 for v86 (VM_ARCH=i686, the default),
#     linux/amd64 for the v86_64 fork (VM_ARCH=x86_64). build-rootfs.sh passes
#     PLATFORM (and BASE=alpine:3.22 for x86_64) accordingly.
#   * must contain /bin/sh (busybox is fine)
#   * must COPY in vm-init + vm-agent (PID 1 and the control-channel agent)
#
# The kernel is NOT part of the image: like Docker itself, the "runtime"
# (guest/build-kernel.sh → bzImage) supplies the kernel and the container
# supplies the userland.

ARG BASE=i386/alpine:3.22
ARG PLATFORM=linux/386
FROM --platform=${PLATFORM} ${BASE}

# Extra packages for the dev environment. Rebuild with e.g.
#   PACKAGES="git nodejs npm python3 vim build-base" npm run guest
ARG PACKAGES="git nodejs npm python3 nano less"
RUN if [ -n "$PACKAGES" ]; then apk add --no-cache $PACKAGES; fi

COPY vm-init  /sbin/vm-init
COPY vm-agent /sbin/vm-agent
COPY welcome/  /root/project/
RUN chmod 755 /sbin/vm-init /sbin/vm-agent /root/project/hello.sh \
 && printf '%s\n' \
      'export PS1="\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ "' \
      'export TERM=xterm-256color' \
      'alias ll="ls -la"' > /root/.profile \
 && mkdir -p /etc/profile.d \
 && printf '%s\n' \
      '# HTTPS inside the VM terminates in the browser tab, with certificates from a' \
      '# CA made per tab (vm-init adds it to the system bundle). Tools that ship' \
      '# their own CA list need to be pointed at it:' \
      'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/browser-vm-ca.pem' \
      'export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt' \
      'export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt PIP_CERT=/etc/ssl/certs/ca-certificates.crt' \
      > /etc/profile.d/browser-vm-network.sh
