// An HTTPS proxy for the scratch Multicord instance only: it runs with
// --proxy-server pointing here and --ignore-certificate-errors. CONNECTs to
// the test hosts are terminated with the run's self-signed certificate and
// forwarded to the plain-http servers Docker publishes; anything else is
// tunnelled unchanged. LiveKit's address inside the Docker network (as
// Synapse and lk-jwt-service name it) becomes wss://<LiveKit host> in JSON
// towards the client, and back again in request bodies. Multicord itself
// talks only https and wss, and none of this changes it.
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/**
 * @param {{ port: number, key: Buffer, cert: Buffer, routes: Record<string, number>, lkHost: string,
 *   lkInternal: string, log?: (line: string) => void }} options routes: test host -> local port
 * @returns {Promise<{ close(): void }>}
 */
export function startProxy({ port, key, cert, routes, lkHost, lkInternal, log = () => {} }) {
  const lkPublic = `wss://${lkHost}`;
  const swap = (text, from, to) => text.split(JSON.stringify(from)).join(JSON.stringify(to));
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  };

  const inner = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const target = routes[host];
    if (!target) return void res.writeHead(502).end();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const rewrite = host !== lkHost;
      if (rewrite && body.length) body = Buffer.from(swap(body.toString("utf8"), lkPublic, lkInternal));
      const headers = { ...req.headers, host: `127.0.0.1:${target}` };
      delete headers["accept-encoding"];
      if (body.length || headers["content-length"] !== undefined) headers["content-length"] = String(body.length);
      const out = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (upstream) => {
        const parts = [];
        upstream.on("data", (c) => parts.push(c));
        upstream.on("end", () => {
          let data = Buffer.concat(parts);
          if (rewrite && /json/.test(upstream.headers["content-type"] ?? "")) data = Buffer.from(swap(data.toString("utf8"), lkInternal, lkPublic));
          const h = { ...upstream.headers, "content-length": String(data.length) };
          delete h["transfer-encoding"];
          log(`${req.method} https://${host}${(req.url ?? "").split("?")[0]} -> ${upstream.statusCode}`);
          res.writeHead(upstream.statusCode ?? 502, h).end(data);
        });
      });
      out.on("error", (e) => {
        log(`${req.method} https://${host}${req.url} !! ${e.message}`);
        res.writeHead(502).end();
      });
      out.end(body);
    });
  });

  // WebSockets (LiveKit's signalling): the request head is rewritten, then bytes flow as they are.
  inner.on("upgrade", (req, socket, head) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const target = routes[host];
    log(`UPGRADE https://${host}${(req.url ?? "").split("?")[0]}`);
    if (!target) return void socket.destroy();
    const upstream = net.connect(target, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(`${name}: ${name.toLowerCase() === "host" ? `127.0.0.1:${target}` : req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    track(upstream);
    const end = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", end);
    socket.on("error", end);
  });

  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connection", track);
  proxy.on("connect", (req, socket, head) => {
    const [host, targetPort = "443"] = (req.url ?? "").split(":");
    socket.on("error", () => undefined);
    if (routes[host]) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ["http/1.1"] });
      secure.on("error", (e) => log(`TLS ${host}: ${e.message}`));
      if (head?.length) socket.unshift(head);
      inner.emit("connection", secure);
      return;
    }
    const upstream = net.connect(Number(targetPort), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    track(upstream);
    upstream.on("error", () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(port, "127.0.0.1", () => {
      log(`proxy on ${port}`);
      resolve({
        close() {
          for (const s of sockets) s.destroy();
          proxy.close();
        },
      });
    });
  });
}
