# Hello from inside the browser VM 👋

This folder is `/root/project` **inside a Linux VM running in your browser tab**
(v86: an x86 CPU emulated in WebAssembly, booting a real Linux kernel).

Things to try in the terminal (Ctrl+`):

    uname -a            # a real Linux kernel (i686, or x86_64 in the 64-bit build)
    cat /etc/os-release # Alpine userland from guest/Dockerfile
    ./hello.sh
    echo hi > from-terminal.txt   # ...watch it appear in the Explorer
    top                 # full-screen apps work; resize the panel

Edit `hello.sh` here in the editor, save, and run it again in the terminal:
the editor and the VM share one filesystem (virtio-9p, backed by JavaScript).

## Network

There is no server behind this page, so the VM's network *is* your browser:
HTTP and HTTPS requests from inside the VM are replayed with `fetch()`.

    wget -qO- https://registry.npmjs.org/left-pad | head -c 300
    wget -qO- https://api.github.com/repos/copy/v86 | grep stargazers

Sites have to allow cross-origin (CORS) access; others are refused, with an
explanation, by the browser. Requests are logged in *Linux VM: Show Boot Log*.
A server you start in the VM is reachable inside it at `localhost`.
