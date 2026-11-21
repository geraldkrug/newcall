// OpenCall signaling server (self-host for g--dk.biz)
// Mirrors the perchance server-plugin router in index.html.
// Run: npm install && node server.js   (needs Node 18+)
// Env: PORT (default 3000)

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const EMOS = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83C\uDF89", "\uD83D\uDC4F", "\uD83D\uDE2E"];
const EMO_SET = new Set(["\uD83D\uDC4D","\u2764\uFE0F","\uD83D\uDE02","\uD83C\uDF89","\uD83D\uDC4F","\uD83D\uDE2E"]);

function validId(id) {
  if (typeof id !== "string" || id.length < 4 || id.length > 40) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}
function cleanName(n) {
  if (typeof n !== "string") return "Guest";
  n = n.slice(0, 24);
  return n.length ? n : "Guest";
}

const peers = new Map(); // id -> ws
const names = new Map(); // id -> name
const meta = new Map();  // ws -> {id, name, n, winStart}

function send(ws, o) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(o)); } catch (e) {}
}
function broadcast(except, o) {
  const d = JSON.stringify(o);
  for (const ws of meta.keys()) {
    if (ws !== except && ws.readyState === 1) {
      try { ws.send(d); } catch (e) {}
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("OpenCall signaling. Connect with ?signal=wss://YOUR-HOST/");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  meta.set(ws, { id: null, name: "", n: 0, winStart: 0 });
  ws.on("message", (buf) => {
    const str = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    if (str.length > 65536 || str.length < 2) return;
    let m;
    try { m = JSON.parse(str); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    const rec = meta.get(ws);
    if (!rec) return;
    const now = Date.now();
    if (now - rec.winStart > 10000) { rec.winStart = now; rec.n = 0; }
    rec.n++;
    if (rec.n > 150) return;
    if (m.t === "hi") {
      if (!validId(m.id)) return;
      const name = cleanName(m.name);
      const other = peers.get(m.id);
      if (other && other !== ws) { send(ws, { t: "taken" }); return; }
      // drop old ids held by this socket
      for (const [id, s] of peers) if (s === ws && id !== m.id) peers.delete(id);
      rec.id = m.id; rec.name = name;
      peers.set(m.id, ws);
      names.set(m.id, name);
      if (m.hb) return;
      const roster = [];
      for (const [id, s] of peers) {
        if (s !== ws && roster.length < 400) roster.push({ id, name: names.get(id) || "Guest" });
      }
      send(ws, { t: "roster", peers: roster });
      broadcast(ws, { t: "join", id: m.id, name });
    } else if (m.t === "sig") {
      if (!rec.id || !validId(m.to)) return;
      if (m.kind !== "offer" && m.kind !== "answer" && m.kind !== "ice") return;
      if (!m.payload || typeof m.payload !== "object") return;
      const target = peers.get(m.to);
      if (!target) { send(ws, { t: "nop", id: m.to }); return; }
      try {
        if (target.readyState === 1) target.send(JSON.stringify({ t: "sig", from: rec.id, kind: m.kind, payload: m.payload }));
        else send(ws, { t: "nop", id: m.to });
      } catch (e) { send(ws, { t: "nop", id: m.to }); }
    } else if (m.t === "chat") {
      if (!rec.id || typeof m.text !== "string") return;
      const text = m.text.slice(0, 500);
      if (!text) return;
      broadcast(null, { t: "chat", id: rec.id, name: rec.name, text, ts: Date.now() });
    } else if (m.t === "react") {
      if (!rec.id || typeof m.emo !== "string" || !EMO_SET.has(m.emo)) return;
      broadcast(null, { t: "react", id: rec.id, name: rec.name, emo: m.emo });
    } else if (m.t === "state") {
      if (!rec.id) return;
      const out = { t: "state", id: rec.id };
      let changed = false;
      if (typeof m.name === "string") {
        const nm = cleanName(m.name);
        if (nm !== rec.name) { rec.name = nm; names.set(rec.id, nm); out.name = nm; changed = true; }
      }
      for (const f of ["hand", "mic", "cam", "sharing"]) {
        if (typeof m[f] === "boolean") { out[f] = m[f]; changed = true; }
      }
      if (!changed) return;
      broadcast(null, out);
    }
  });
  ws.on("close", () => {
    const rec = meta.get(ws);
    meta.delete(ws);
    if (rec && rec.id && peers.get(rec.id) === ws) {
      peers.delete(rec.id);
      broadcast(null, { t: "leave", id: rec.id });
    }
  });
});

server.listen(PORT, () => console.log("OpenCall signaling on :" + PORT));
