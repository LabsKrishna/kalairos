// tests/free-port.js — a loopback TCP port the OS just handed out.
//
// Tests that spawn server.js used to pick a random port, and on Windows CI one
// landed on a port the server couldn't bind (reserved, or in use). A port the
// OS assigns was bindable a moment ago; the gap before the child binds it is
// the only race left.
"use strict";

const net = require("net");

module.exports = function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
};
