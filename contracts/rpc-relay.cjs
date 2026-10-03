// Minimal HTTP->HTTPS JSON-RPC relay so forge speaks plain HTTP/1.1 to localhost
// and this process does the TLS to the RH testnet RPC via Node/OpenSSL (robust,
// no HTTP-2 reuse). Works around forge's `BadRecordMac` on this endpoint.
const http = require("http");
const https = require("https");

const UPSTREAM = { host: "rpc.testnet.chain.robinhood.com", port: 443, path: "/" };
const PORT = 8899;
const agent = new https.Agent({ keepAlive: false }); // fresh connection per request

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const up = https.request(
      { ...UPSTREAM, method: "POST", agent, headers: { "content-type": "application/json", "content-length": body.length } },
      (ur) => {
        const out = [];
        ur.on("data", (c) => out.push(c));
        ur.on("end", () => {
          res.writeHead(ur.statusCode || 200, { "content-type": "application/json" });
          res.end(Buffer.concat(out));
        });
      }
    );
    up.on("error", (e) => { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); });
    up.end(body);
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`relay on http://127.0.0.1:${PORT}`));
