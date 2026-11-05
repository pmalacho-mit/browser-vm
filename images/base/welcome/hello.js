// Runs if the guest image includes nodejs (the default Dockerfile does).
console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
