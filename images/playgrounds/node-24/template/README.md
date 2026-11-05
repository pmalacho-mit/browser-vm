# Node.js 24 playground

This is `/root/project` in a Linux VM running in your browser tab.

    node index.js              # run the example
    npm start                  # the same, through npm
    node                       # interactive REPL
    npm install left-pad       # packages from npm (allowed by the network gate)

The VM emulates an x86 CPU in WebAssembly, so Node takes a few seconds to
start. Nothing is kept after you close the tab, so download anything you want
to keep.
