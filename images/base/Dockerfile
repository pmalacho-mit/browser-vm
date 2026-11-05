# The base image's userland. This is an ordinary Dockerfile: whatever you put in
# here ends up as the root filesystem of the Linux VM running in the browser.
#
# Requirements:
#   * must match the emulator's CPU: linux/386 for v86 (VM_ARCH=i686, the default),
#     linux/amd64 for the v86_64 fork (VM_ARCH=x86_64). build.sh passes
#     PLATFORM (and BASE=alpine:3.22 for x86_64) accordingly.
#   * must contain /bin/sh (busybox is fine)
#   * must COPY in vm-init + vm-agent: the runtime's guest half (PID 1 and the
#     control-channel agent), every image's contract with the runtime
#
# The kernel is NOT part of the image: like Docker itself, the machine
# (machines/kernel/build.sh → bzImage) supplies the kernel and the image
# supplies the userland.

ARG BASE=i386/alpine:3.22
ARG PLATFORM=linux/386
FROM --platform=${PLATFORM} ${BASE}

# Extra packages for the dev environment. Rebuild with e.g.
#   PACKAGES="git nodejs npm python3 vim build-base" npm run image
ARG PACKAGES="git nodejs npm python3 nano less"
RUN if [ -n "$PACKAGES" ]; then apk add --no-cache $PACKAGES; fi

# The runtime's guest half (runtime/guest/, the "guest" build context from build.sh).
COPY --from=guest vm-init  /sbin/vm-init
COPY --from=guest vm-agent /sbin/vm-agent
COPY welcome/  /root/project/
# Shell profile and the CA settings for HTTPS (also used by images/builder/build-playgrounds.mjs).
COPY overlay/  /
RUN chmod 755 /sbin/vm-init /sbin/vm-agent /root/project/hello.sh
