// Run me in the terminal: node index.js
import os from "node:os";

const name = process.argv[2] ?? "world";
console.log(`Hello, ${name}, from Node.js ${process.version} on ${os.arch()}!`);
