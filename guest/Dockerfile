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
# Shell profile and the CA settings for HTTPS (also used by scripts/build-playgrounds.mjs).
COPY overlay/  /
RUN chmod 755 /sbin/vm-init /sbin/vm-agent /root/project/hello.sh
