/* OpenCall client — one shared call, full-mesh WebRTC. Server only signals. */
(function(){
"use strict";
var $ = function(id){ return document.getElementById(id); };
function rid(){
  var c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", s = "", i;
  for (i = 0; i < 12; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
var toastT = null;
function toast(m){
  var t = $("toast");
  t.textContent = m; t.classList.add("show");
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(function(){ t.classList.remove("show"); }, 2400);
}

/* ================= identity ================= */
var ME = rid();
var myName = "Guest";
try {
  var sn = localStorage.getItem("oc-name");
  myName = sn ? sn : "Guest-" + Math.floor(1000 + Math.random() * 9000);
} catch (e) { myName = "Guest-" + Math.floor(1000 + Math.random() * 9000); }

/* ================= ICE ================= */
var ICE = [
  {urls: "stun:stun.l.google.com:19302"},
  {urls: "stun:stun.cloudflare.com:3478"},
  {urls: "stun:global.stun.twilio.com:3478"}
];
try {
  var qs = new URLSearchParams(location.search);
  ["turn", "turns"].forEach(function(k){
    var v = qs.get(k);
    if (!v) return;
    var at = v.lastIndexOf("@");
    if (at < 1) return;
    var cred = v.slice(0, at).split(":");
    if (cred.length < 2) return;
    ICE.push({urls: (k === "turns" ? "turns:" : "turn:") + v.slice(at + 1),
      username: cred[0], credential: cred.slice(1).join(":")});
  });
} catch (e) {}

/* ================= media state ================= */
var localStream = null, micTrack = null, camTrack = null;
var micOn = true, camOn = true, sharing = false, shareStream = null;
var audioGateDone = false, audioMonCtx = null;
var closedByUser = false, reconnectDelay = 1000;

/* ================= peer context (app + test bot share this) ================= */
function makeCtx(o){
  return {me: o.id, name: o.name, stream: o.stream || null, sock: null,
    peers: new Map(), ui: !!o.ui, hbTimer: null, closed: false,
    tracks: o.tracks || function(){ return o.stream ? o.stream.getTracks() : []; },
    onEvent: o.onEvent || function(){}};
}
function sendMsg(ctx, o){ try { ctx.sock.send(JSON.stringify(o)); } catch (e) {} }
function sendHi(ctx, hb){
  var o = {t: "hi", id: ctx.me, name: ctx.name};
  if (hb) o.hb = 1;
  sendMsg(ctx, o);
}
function makeExternalSock(url){
  var ws;
  try { ws = new WebSocket(url); } catch (e) { return root.createServerSocket(); }
  var self = {_ml: [], _ol: [], _cl: [], _ws: ws};
  ws.addEventListener("open", function(ev){ self._ol.forEach(function(f){ try { f(ev); } catch (e2) {} }); });
  ws.addEventListener("message", function(ev){
    var d = (typeof ev.data === "string") ? ev.data : "";
    self._ml.forEach(function(f){ try { f({data: d}); } catch (e2) {} });
  });
  ws.addEventListener("close", function(ev){ self._cl.forEach(function(f){ try { f({code: ev.code}); } catch (e2) {} }); });
  ws.addEventListener("error", function(){});
  self.addEventListener = function(t, f){
    if (t === "message") self._ml.push(f);
    else if (t === "open") self._ol.push(f);
    else if (t === "close") self._cl.push(f);
  };
  self.send = function(d){ try { if (ws.readyState === 1) ws.send(d); } catch (e2) {} };
  self.close = function(c, r){ try { ws.close(c || 1000, r || "bye"); } catch (e2) {} };
  return self;
}
function attachSocket(ctx, makeSock){
  if (!makeSock) {
    try {
      var q = new URLSearchParams(location.search);
      var wsUrl = q.get("signal");
      if (wsUrl) makeSock = function(){ return makeExternalSock(wsUrl); };
    } catch (e) {}
  }
  var s = (makeSock || function(){ return root.createServerSocket(); })();
  ctx.sock = s;
  s.addEventListener("open", function(){
    if (ctx.ui) { setNet(true); hideErr(); }
    reconnectDelay = 1000;
    sendHi(ctx, false);
    if (ctx.hbTimer) clearInterval(ctx.hbTimer);
    ctx.hbTimer = setInterval(function(){ if (!ctx.closed) sendHi(ctx, true); }, 18000);
  });
  s.addEventListener("message", function(ev){ onSockMsg(ctx, ev.data); });
  s.addEventListener("close", function(ev){ onSockClose(ctx, ev); });
}
function onSockMsg(ctx, raw){
  var m;
  try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
  catch (e) { return; }
  if (!m || typeof m.t !== "string") return;
  if (m.t === "roster" && Array.isArray(m.peers)) {
    m.peers.forEach(function(p){
      if (p && p.id && p.id !== ctx.me) ensurePeer(ctx, p.id, p.name || "Guest", ctx.me > p.id);
    });
  } else if (m.t === "join") {
    if (m.id && m.id !== ctx.me) {
      var isNew = !ctx.peers.has(m.id);
      ensurePeer(ctx, m.id, m.name || "Guest", ctx.me > m.id);
      if (isNew) ctx.onEvent({k: "sys", text: (m.name || "Guest") + " joined"});
    }
  } else if (m.t === "leave") {
    if (m.id && m.id !== ctx.me) {
      var P = ctx.peers.get(m.id);
      dropPeer(ctx, m.id);
      if (P) ctx.onEvent({k: "sys", text: P.name + " left"});
    }
  } else if (m.t === "sig") {
    if (m.from && m.from !== ctx.me) onSig(ctx, m);
  } else if (m.t === "chat") {
    if (typeof m.text === "string" && m.text) ctx.onEvent({k: "chat", name: m.name || "Guest", text: m.text, ts: m.ts});
  } else if (m.t === "react") {
    if (typeof m.emo === "string" && m.emo) ctx.onEvent({k: "react", id: m.id, emo: m.emo});
  } else if (m.t === "state") {
    var Q = ctx.peers.get(m.id);
    if (Q) {
      if (typeof m.name === "string") Q.name = m.name;
      ["hand", "mic", "cam", "sharing"].forEach(function(f){ if (typeof m[f] === "boolean") Q[f] = m[f]; });
      ctx.onEvent({k: "update", peer: Q});
    }
  } else if (m.t === "nop") {
    if (m.id) dropPeer(ctx, m.id);
  } else if (m.t === "taken") {
    ctx.me = rid();
    if (ctx.ui) ME = ctx.me;
    sendHi(ctx, false);
  }
}
function onSockClose(ctx, ev){
  if (ctx.hbTimer) { clearInterval(ctx.hbTimer); ctx.hbTimer = null; }
  var code = ev && ev.code;
  if (!ctx.ui) return; // bot sockets: no auto-reconnect
  setNet(false);
  if (code === 4403) {
    showErr("Embedding is blocked here: open this page on perchance.org directly (share the link, do not put it in an iframe).");
    return;
  }
  if (code === 4429) {
    showErr("Server is busy — retrying shortly. Keep this tab open.");
  }
  if (closedByUser || code === 1000) return;
  showErr("Connection lost — reconnecting…");
  if (ctx._rt) clearTimeout(ctx._rt);
  ctx._rt = setTimeout(function(){
    ctx._rt = null;
    if (!closedByUser) attachSocket(ctx);
  }, reconnectDelay + Math.random() * 500);
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

/* ================= WebRTC mesh ================= */
function ensurePeer(ctx, id, name, offer){
  if (!id || id === ctx.me) return null;
  var P = ctx.peers.get(id);
  if (P) {
    if (name && name !== P.name) { P.name = name; ctx.onEvent({k: "update", peer: P}); }
    return P;
  }
  P = {id: id, name: name || "Guest", pc: null, stream: null, makingOffer: false,
    polite: ctx.me < id, mic: true, cam: true, hand: false, sharing: false,
    iceQ: [], el: null, videoEl: null, tagEl: null, analyser: null, anaData: null};
  ctx.peers.set(id, P);
  ctx.onEvent({k: "add", peer: P});
  if (offer) offerPeer(ctx, P);
  return P;
}
function buildPC(ctx, P){
  if (P.pc) { try { P.pc.close(); } catch (e) {} }
  var pc = new RTCPeerConnection({iceServers: ICE});
  P.pc = pc; P.makingOffer = false; P.iceQ = [];
  ctx.tracks().forEach(function(t){ try { pc.addTrack(t, ctx.stream); } catch (e) {} });
  P.dc = null;
  try {
    if (ctx.me > P.id) P.dc = pc.createDataChannel("oc-file", {ordered: true});
  } catch (e) { P.dc = null; }
  pc.ondatachannel = function(ev){ hookDC(ctx, P, ev.channel); };
  if (P.dc) hookDC(ctx, P, P.dc);
  pc.onicecandidate = function(ev){
    if (ev.candidate) sendMsg(ctx, {t: "sig", to: P.id, kind: "ice", payload: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate});
  };
  pc.ontrack = function(ev){
    P.stream = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]);
    ctx.onEvent({k: "track", peer: P});
  };
  pc.onnegotiationneeded = function(){
    if (!P.makingOffer && pc.signalingState === "stable") offerPeer(ctx, P);
  };
  pc.onconnectionstatechange = function(){
    if (pc.connectionState === "failed" && ctx.me > P.id) {
      try { pc.restartIce(); } catch (e) {}
      offerPeer(ctx, P);
    }
  };
}
async function offerPeer(ctx, P){
  if (P.makingOffer) return;
  if (!P.pc) buildPC(ctx, P);
  try {
    P.makingOffer = true;
    await P.pc.setLocalDescription(await P.pc.createOffer());
    sendMsg(ctx, {t: "sig", to: P.id, kind: "offer", payload: P.pc.localDescription});
  } catch (e) { P.makingOffer = false; }
}
async function drainIce(P){
  if (!P.pc || !P.pc.remoteDescription) return;
  var q = P.iceQ; P.iceQ = [];
  for (var i = 0; i < q.length; i++) {
    try { await P.pc.addIceCandidate(new RTCIceCandidate(q[i])); } catch (e) {}
  }
}
async function onSig(ctx, m){
  var P = ctx.peers.get(m.from);
  if (!P) P = ensurePeer(ctx, m.from, m.name || "Guest", false);
  if (!P) return;
  try {
    if (m.kind === "offer") {
      if (!P.polite && (P.makingOffer || (P.pc && P.pc.signalingState !== "stable"))) return; // lost the race: ignore
      if (!P.pc) buildPC(ctx, P);
      if (P.pc.signalingState !== "stable") {
        try { await P.pc.setLocalDescription({type: "rollback"}); } catch (e) {}
      }
      await P.pc.setRemoteDescription(m.payload);
      await drainIce(P);
      var ans = await P.pc.createAnswer();
      await P.pc.setLocalDescription(ans);
      sendMsg(ctx, {t: "sig", to: P.id, kind: "answer", payload: P.pc.localDescription});
    } else if (m.kind === "answer") {
      if (!P.pc) return;
      await P.pc.setRemoteDescription(m.payload);
      P.makingOffer = false;
      await drainIce(P);
    } else if (m.kind === "ice") {
      if (P.pc && P.pc.remoteDescription) {
        try { await P.pc.addIceCandidate(new RTCIceCandidate(m.payload)); } catch (e) {}
      } else P.iceQ.push(m.payload);
    }
  } catch (e) {}
}
/* ---------- file sharing over RTCDataChannel (mesh) ---------- */
var FILE_CHUNK = 16384, FILE_MAX = 50 * 1024 * 1024;
var fileSeq = 0, incoming = {}; // key peerId:fid -> {name,size,type,parts,got,li,bar}
function hookDC(ctx, P, dc){
  P.dc = dc;
  dc.binaryType = "arraybuffer";
  dc.onmessage = function(ev){ onFileMsg(ctx, P, ev.data); };
  dc.onopen = function(){ ctx.onEvent({k: "dc", peer: P}); };
}
function dcOpen(P){ return P.dc && P.dc.readyState === "open"; }
function sendFile(file){
  if (!file) return;
  if (file.size > FILE_MAX) { toast("File too big (50 MB max)"); return; }
  var targets = peerList().filter(dcOpen);
  if (!targets.length) { toast("No connected peers yet"); return; }
  var fid = "f" + (++fileSeq) + "-" + rid().slice(0, 4);
  renderSys("Sending " + file.name + " (" + Math.ceil(file.size / 1024) + " KB) to " + targets.length + " peer" + (targets.length > 1 ? "s" : ""));
  targets.forEach(function(P){ sendFileTo(P, fid, file); });
}
async function sendFileTo(P, fid, file){
  var head = JSON.stringify({t: "file-head", fid: fid, name: file.name.slice(0, 120), size: file.size, type: file.type || "application/octet-stream"});
  try {
    P.dc.send(head);
    var off = 0;
    while (off < file.size) {
      while (P.dc.bufferedAmount > 1024 * 1024) await new Promise(function(r){ setTimeout(r, 60); });
      if (P.dc.readyState !== "open") return;
      var part = file.slice(off, off + FILE_CHUNK);
      var buf = await part.arrayBuffer();
      P.dc.send(buf);
      off += buf.byteLength;
    }
    P.dc.send(JSON.stringify({t: "file-end", fid: fid}));
  } catch (e) {}
}
function onFileMsg(ctx, P, data){
  if (typeof data === "string") {
    var m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.fid !== "string") return;
    var key = P.id + ":" + m.fid;
    if (m.t === "file-head") {
      if (typeof m.size !== "number" || m.size < 0 || m.size > FILE_MAX) return;
      incoming[key] = {fid: m.fid, name: String(m.name || "file").slice(0, 120), size: m.size,
        type: String(m.type || "application/octet-stream"), parts: [], got: 0};
      ctx.onEvent({k: "file-start", peer: P, fid: m.fid, name: incoming[key].name, size: m.size});
    } else if (m.t === "file-end") {
      var f = incoming[key];
      if (!f) return;
      delete incoming[key];
      var blob = new Blob(f.parts, {type: f.type});
      ctx.onEvent({k: "file", peer: P, fid: m.fid, name: f.name, size: f.size, blob: blob});
    }
  } else if (data instanceof ArrayBuffer) {
    // binary chunk: attribute to this peer's most recent open transfer
    var best = null, bestKey = "";
    Object.keys(incoming).forEach(function(k){
      if (k.indexOf(P.id + ":") === 0 && (!best || incoming[k].got > best.got)) { best = incoming[k]; bestKey = k; }
    });
    if (best) {
      best.parts.push(data); best.got += data.byteLength;
      ctx.onEvent({k: "file-progress", peer: P, fid: best.fid, name: best.name, size: best.size, got: best.got});
    }
  }
}
function dropPeer(ctx, id){
  var P = ctx.peers.get(id);
  if (!P) return;
  ctx.peers.delete(id);
  if (P.pc) { try { P.pc.close(); } catch (e) {} P.pc = null; }
  ctx.onEvent({k: "remove", peer: P});
}
/* current outbound tracks: mic + (screen while sharing, else camera) */
function outTracks(){
  var t = [];
  if (micTrack) t.push(micTrack);
  var v = (sharing && shareStream && shareStream.getVideoTracks()[0]) || camTrack;
  if (v) t.push(v);
  return t;
}
/* reconcile a context's peer connections with an explicit track list.
   Covers late adds (screen share starting, devices appearing) and removals of
   ended tracks. Renegotiation rides on negotiationneeded for the offerer. */
function resyncOutboundCtx(ctx, tracks, streamHint){
  var list = [];
  ctx.peers.forEach(function(P){ list.push(P); });
  list.forEach(function(P){
    if (!P.pc) return;
    var senders = {};
    P.pc.getSenders().forEach(function(s){ if (s.track) senders[s.track.kind] = s; });
    tracks.forEach(function(t){
      var s = senders[t.kind];
      if (s) { if (s.track !== t) { try { s.replaceTrack(t); } catch (e) {} } }
      else { try { P.pc.addTrack(t, streamHint); } catch (e) {} }
    });
    ["audio", "video"].forEach(function(kind){
      var want = tracks.some(function(t){ return t.kind === kind; });
      var s = senders[kind];
      if (!want && s && s.track && s.track.readyState === "ended") {
        try { P.pc.removeTrack(s); } catch (e) {}
      }
    });
  });
}
/* app wrapper: current outbound tracks + local preview refresh */
function resyncOutbound(){
  resyncOutboundCtx(ctxApp, outTracks(), localStream || shareStream);
  paintLocalPreview();
}
function paintLocalPreview(){
  if (!localVideo || !localBox) return;
  if (sharing && shareStream) localVideo.srcObject = shareStream;
  else localVideo.srcObject = localStream;
  var showPlaceholder = sharing ? false : !(localStream && localStream.getVideoTracks().length && camOn);
  localBox._nov.hidden = !showPlaceholder;
  if (showPlaceholder) localBox._nov.textContent = localStream ? myName.charAt(0).toUpperCase() : "no camera";
}

/* ================= app context + UI ================= */
var ctxApp = makeCtx({id: ME, name: myName, ui: true, tracks: outTracks, onEvent: onAppEvent});
function peerList(){ return Array.from(ctxApp.peers.values()); }

function setNet(live){
  var d = $("netDot");
  d.classList.toggle("live", !!live);
  d.classList.toggle("dead", !live);
  updateCount();
}
function updateCount(){
  var n = 1 + ctxApp.peers.size;
  $("countEl").textContent = n + (n === 1 ? " person" : " people") + " in call";
}
function showErr(m){ var b = $("errBanner"); b.textContent = m; b.hidden = false; }
function hideErr(){ $("errBanner").hidden = true; }

function onAppEvent(ev){
  if (ev.k === "add") { buildTile(ev.peer); updateCount(); renderPeople(); }
  else if (ev.k === "remove") { removeTile(ev.peer); updateCount(); renderPeople(); }
  else if (ev.k === "update") { paintTile(ev.peer); renderPeople(); }
  else if (ev.k === "track") { attachTrack(ev.peer); startMonitor(ev.peer); }
  else if (ev.k === "chat") { renderChat(ev.name, ev.text, ev.ts); bumpBadge(); }
  else if (ev.k === "react") { floatReact(ev.id, ev.emo); }
  else if (ev.k === "file-start") { renderFileProgress(ev.peer, ev.fid, ev.name, ev.size, 0); }
  else if (ev.k === "file-progress") { renderFileProgress(ev.peer, ev.fid, ev.name, ev.size, ev.got); }
  else if (ev.k === "file") { finishFile(ev.peer, ev.fid, ev.name, ev.size, ev.blob); }
  else if (ev.k === "sys") { renderSys(ev.text); }
}
function applyPeerMute(P){
  if (P.videoEl) P.videoEl.muted = !!P.localMuted || !audioGateDone;
}
function buildTile(P){
  var box = document.createElement("div");
  box.className = "tile";
  box.title = "click to mute / unmute them for you only";
  box.addEventListener("click", function(){
    P.localMuted = !P.localMuted;
    applyPeerMute(P); paintTile(P);
    toast(P.localMuted ? "Muted " + P.name + " for you" : "Unmuted " + P.name);
  });
  var v = document.createElement("video");
  v.autoplay = true; v.playsInline = true; v.muted = !audioGateDone;
  var tag = document.createElement("div");
  tag.className = "tag";
  var hb = document.createElement("span");
  hb.className = "handb"; hb.textContent = "✋";
  box.appendChild(v); box.appendChild(tag); box.appendChild(hb);
  $("gridEl").appendChild(box);
  P.el = box; P.videoEl = v; P.tagEl = tag;
  if (P.stream) attachTrack(P);
  paintTile(P);
}
function removeTile(P){
  if (P.el && P.el.parentNode) P.el.parentNode.removeChild(P.el);
  P.el = null; P.videoEl = null; P.tagEl = null;
}
function attachTrack(P){
  if (P.videoEl && P.stream) {
    P.videoEl.srcObject = P.stream;
    applyPeerMute(P);
    var pr = P.videoEl.play();
    if (pr && pr.catch) pr.catch(function(){});
  }
  paintTile(P);
}
function paintTile(P){
  if (!P.tagEl) return;
  P.tagEl.innerHTML = "";
  var nm = document.createElement("span"); nm.textContent = P.name;
  var mic = document.createElement("span");
  mic.textContent = (!P.mic || P.localMuted) ? "🔇" : "🎤";
  P.tagEl.appendChild(nm); P.tagEl.appendChild(mic);
  if (P.el) {
    P.el.classList.toggle("raised", !!P.hand);
    P.el.classList.toggle("selfmuted", !!P.localMuted);
  }
}
function renderPeople(){
  var ul = $("peopleList"); ul.innerHTML = "";
  var me = document.createElement("li");
  me.innerHTML = "";
  var a = document.createElement("span"); a.textContent = myName + " (you)";
  var b = document.createElement("span"); b.className = "st";
  b.textContent = (micOn ? "🎤" : "🔇") + " " + (camOn ? "📷" : "🚫");
  me.appendChild(a); me.appendChild(b); ul.appendChild(me);
  peerList().forEach(function(P){
    var li = document.createElement("li");
    var n = document.createElement("span"); n.textContent = P.name + (P.hand ? " ✋" : "");
    var s = document.createElement("span"); s.className = "st";
    s.textContent = (P.mic ? "🎤" : "🔇") + " " + (P.cam ? "📷" : "🚫");
    li.appendChild(n); li.appendChild(s); ul.appendChild(li);
  });
}
function renderChat(name, text, ts){
  var li = document.createElement("li");
  var who = document.createElement("span"); who.className = "who"; who.textContent = name;
  var tm = document.createElement("span"); tm.className = "ts";
  try { tm.textContent = new Date(ts || Date.now()).toLocaleTimeString(); } catch (e) {}
  var tx = document.createElement("div"); tx.textContent = text;
  li.appendChild(who); li.appendChild(tm); li.appendChild(tx);
  var list = $("chatList");
  list.appendChild(li);
  while (list.children.length > 100) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}
function kb(n){ return n < 1024 ? n + " B" : Math.ceil(n / 1024) + " KB"; }
function renderFileProgress(peer, fid, name, size, got){
  var list = $("chatList");
  var id = "fp-" + peer.id + "-" + fid;
  var li = document.getElementById(id);
  if (!li) {
    li = document.createElement("li"); li.id = id; li.className = "sys";
    list.appendChild(li);
    while (list.children.length > 100) list.removeChild(list.firstChild);
  }
  var pct = size ? Math.min(100, Math.round(got / size * 100)) : 100;
  li.textContent = "Receiving " + name + " from " + peer.name + " — " + pct + "%";
  list.scrollTop = list.scrollHeight;
}
function finishFile(peer, fid, name, size, blob){
  var old = document.getElementById("fp-" + peer.id + "-" + fid);
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var li = document.createElement("li");
  var who = document.createElement("span"); who.className = "who"; who.textContent = peer.name;
  var tx = document.createElement("div");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.textContent = "⬇ " + name + " (" + kb(size) + ")";
  tx.appendChild(a); li.appendChild(who); li.appendChild(tx);
  var list = $("chatList");
  list.appendChild(li);
  while (list.children.length > 100) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
  bumpBadge();
  toast("Received " + name);
}
function renderSys(text){
  var li = document.createElement("li");
  li.className = "sys"; li.textContent = text;
  var list = $("chatList");
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}
function bumpBadge(){
  if ($("sideEl").hidden || $("chatPane").hidden) {
    var b = $("chatBadge"), n = parseInt(b.textContent || "0", 10) + 1;
    b.textContent = n > 9 ? "9+" : String(n); b.hidden = false;
  }
}

/* local tile */
var localBox = null, localVideo = null, localTag = null;
function buildLocalTile(){
  localBox = document.createElement("div");
  localBox.className = "tile mine";
  localVideo = document.createElement("video");
  localVideo.autoplay = true; localVideo.playsInline = true; localVideo.muted = true;
  localTag = document.createElement("div"); localTag.className = "tag";
  var hb = document.createElement("span"); hb.className = "handb"; hb.textContent = "✋";
  var nov = document.createElement("div"); nov.className = "novideo"; nov.hidden = true;
  localBox.appendChild(localVideo); localBox.appendChild(localTag); localBox.appendChild(hb); localBox.appendChild(nov);
  localBox._nov = nov; localBox._hb = hb;
  var g = $("gridEl");
  g.insertBefore(localBox, g.firstChild);
  paintLocal();
}
function paintLocal(){
  if (!localTag) return;
  localTag.innerHTML = "";
  var nm = document.createElement("span"); nm.textContent = myName + " (you)";
  var mic = document.createElement("span"); mic.textContent = micOn ? "🎤" : "🔇";
  localTag.appendChild(nm); localTag.appendChild(mic);
  paintLocalPreview();
}

/* speaking monitor */
function ensureMonCtx(){
  if (!audioMonCtx) {
    try { audioMonCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audioMonCtx && audioMonCtx.state === "suspended" && audioGateDone) {
    audioMonCtx.resume().catch(function(){});
  }
  return audioMonCtx;
}
function startMonitor(P){
  if (!P.stream || P.analyser) return;
  var ac = ensureMonCtx();
  if (!ac) return;
  try {
    var src = ac.createMediaStreamSource(P.stream);
    var an = ac.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    P.analyser = an; P.anaData = new Uint8Array(an.fftSize);
  } catch (e) {}
}
setInterval(function(){
  if (document.hidden) return;
  peerList().forEach(function(P){
    if (!P.analyser || !P.el) return;
    try {
      P.analyser.getByteTimeDomainData(P.anaData);
      var sum = 0;
      for (var i = 0; i < P.anaData.length; i += 4) {
        var d = P.anaData[i] - 128;
        sum += d * d;
      }
      var lvl = Math.sqrt(sum / (P.anaData.length / 4));
      P.el.classList.toggle("speaking", lvl > 6);
    } catch (e) {}
  });
}, 300);

/* audio gate: browsers block unmuted autoplay until a gesture */
function passGate(){
  if (audioGateDone) return;
  audioGateDone = true;
  ensureMonCtx();
  peerList().forEach(function(P){
    if (P.videoEl) { applyPeerMute(P); var pr = P.videoEl.play(); if (pr && pr.catch) pr.catch(function(){}); }
    startMonitor(P);
  });
  $("audioGate").hidden = true;
}
["pointerdown", "keydown"].forEach(function(t){
  window.addEventListener(t, passGate, {passive: true});
});

/* ================= actions ================= */
function broadcastState(o){ o.t = "state"; sendMsg(ctxApp, o); }
function toggleMic(){
  micOn = !micOn;
  if (micTrack) micTrack.enabled = micOn;
  $("micBtn").classList.toggle("on", micOn);
  paintLocal(); renderPeople(); broadcastState({mic: micOn});
}
function toggleCam(){
  camOn = !camOn;
  if (camTrack) camTrack.enabled = camOn;
  $("camBtn").classList.toggle("on", camOn);
  paintLocal(); renderPeople(); broadcastState({cam: camOn});
}
function toggleHand(){
  var on = !$("handBtn").classList.contains("on");
  $("handBtn").classList.toggle("on", on);
  if (localBox) localBox.classList.toggle("raised", on);
  if (localBox) localBox._hb.style.display = on ? "block" : "";
  broadcastState({hand: on});
  toast(on ? "Hand raised" : "Hand lowered");
}
async function toggleShare(){
  if (sharing) { stopShare(); return; }
  var md = navigator.mediaDevices;
  if (!md || !md.getDisplayMedia) { toast("Screen share not supported here"); return; }
  try { shareStream = await md.getDisplayMedia({video: true, audio: false}); }
  catch (e) { return; }
  sharing = true;
  var track = shareStream.getVideoTracks()[0];
  if (track) track.addEventListener("ended", stopShare);
  resyncOutbound();
  $("shareBtn").classList.add("on");
  broadcastState({sharing: true});
  toast("Sharing your screen");
}
function stopShare(){
  if (!sharing) return;
  sharing = false;
  if (shareStream) { shareStream.getTracks().forEach(function(t){ try { t.stop(); } catch (e) {} }); shareStream = null; }
  resyncOutbound();
  $("shareBtn").classList.remove("on");
  broadcastState({sharing: false});
}
function floatReact(id, emo){
  var box = null;
  if (id === ctxApp.me) box = localBox;
  else { var P = ctxApp.peers.get(id); if (P) box = P.el; }
  if (!box) return;
  var s = document.createElement("span");
  s.className = "floater"; s.textContent = emo;
  box.appendChild(s);
  setTimeout(function(){ if (s.parentNode) s.parentNode.removeChild(s); }, 1700);
}
function sendReact(emo){
  sendMsg(ctxApp, {t: "react", emo: emo});
}
function copyLink(){  var url = "https://perchance.org/" + (window.generatorName || "");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function(){ toast("Link copied — anyone who opens it joins"); }, function(){ toast(url); });
  } else toast(url);
}
function sendChat(){
  var inp = $("chatInput"), text = inp.value.trim();
  if (!text) return;
  sendMsg(ctxApp, {t: "chat", text: text.slice(0, 500)});
  inp.value = "";
}
function leaveCall(){
  closedByUser = true;
  if (ctxApp.hbTimer) clearInterval(ctxApp.hbTimer);
  try { ctxApp.sock.close(1000, "left"); } catch (e) {}
  [localStream, shareStream].forEach(function(s){
    if (s) s.getTracks().forEach(function(t){ try { t.stop(); } catch (e) {} });
  });
  $("leftOverlay").hidden = false;
}

/* devices */
async function fillDevices(){
  var md = navigator.mediaDevices;
  if (!md || !md.enumerateDevices) return;
  var devs = [];
  try { devs = await md.enumerateDevices(); } catch (e) { return; }
  var ms = $("micSel"), cs = $("camSel");
  ms.innerHTML = ""; cs.innerHTML = "";
  devs.forEach(function(d){
    var o = document.createElement("option");
    o.value = d.deviceId; o.textContent = d.label || (d.kind + " " + (ms.children.length + 1));
    if (d.kind === "audioinput") ms.appendChild(o);
    else if (d.kind === "videoinput") cs.appendChild(o.cloneNode(true));
  });
}
async function switchDevice(kind, id){
  var md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || !localStream) return;
  try {
    var c = kind === "mic" ? {audio: {deviceId: {exact: id}}} : {video: {deviceId: {exact: id}}};
    var ns = await md.getUserMedia(c);
    var nt = kind === "mic" ? ns.getAudioTracks()[0] : ns.getVideoTracks()[0];
    if (!nt) return;
    if (kind === "mic") {
      if (micTrack) { try { micTrack.stop(); } catch (e) {} localStream.removeTrack(micTrack); }
      micTrack = nt; micTrack.enabled = micOn;
      localStream.addTrack(nt);
    } else {
      if (sharing) { toast("Stop screen share first"); try { nt.stop(); } catch (e) {} return; }
      if (camTrack) { try { camTrack.stop(); } catch (e) {} localStream.removeTrack(camTrack); }
      camTrack = nt; camTrack.enabled = camOn;
      localStream.addTrack(nt);
      if (localVideo) localVideo.srcObject = localStream;
    }
    resyncOutbound();
    ns.getTracks().forEach(function(t){ if (t !== nt) { try { t.stop(); } catch (e) {} } });
  } catch (e) { toast("Could not switch device"); }
}

/* camera/mic acquisition with graceful fallbacks */
async function initMedia(){
  var md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return "none";
  try {
    localStream = await md.getUserMedia({video: {width: {ideal: 1280}, height: {ideal: 720}}, audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
    return "av";
  } catch (e1) {
    try { localStream = await md.getUserMedia({audio: true}); toast("Camera unavailable — audio only"); return "audio"; }
    catch (e2) { return "none"; }
  }
}

/* ================= wire up ================= */
function wire(){
  $("micBtn").addEventListener("click", toggleMic);
  $("camBtn").addEventListener("click", toggleCam);
  $("handBtn").addEventListener("click", toggleHand);
  $("shareBtn").addEventListener("click", toggleShare);
  $("copyBtn").addEventListener("click", copyLink);
  $("leaveBtn").addEventListener("click", leaveCall);
  Array.prototype.forEach.call(document.querySelectorAll(".emo"), function(b){
    b.addEventListener("click", function(){ sendReact(b.getAttribute("data-emo")); });
  });
  $("rejoinBtn").addEventListener("click", function(){ location.reload(); });
  $("sendBtn").addEventListener("click", sendChat);
  $("fileInput").addEventListener("change", function(e){
    if (e.target.files && e.target.files[0]) sendFile(e.target.files[0]);
    e.target.value = "";
  });
  $("chatInput").addEventListener("keydown", function(e){ if (e.key === "Enter") sendChat(); });
  $("chatBtn").addEventListener("click", function(){
    var side = $("sideEl");
    side.hidden = !side.hidden;
    if (!side.hidden) { $("chatPane").hidden = false; $("peoplePane").hidden = true; syncTabs(); $("chatBadge").hidden = true; $("chatBadge").textContent = ""; }
  });
  $("tabChatBtn").addEventListener("click", function(){
    $("chatPane").hidden = false; $("peoplePane").hidden = true; syncTabs();
    $("chatBadge").hidden = true; $("chatBadge").textContent = "";
  });
  $("tabPeopleBtn").addEventListener("click", function(){
    $("chatPane").hidden = true; $("peoplePane").hidden = false; syncTabs();
  });
  $("setBtn").addEventListener("click", function(){
    $("nameInput").value = myName;
    $("settingsPop").hidden = false;
  });
  $("settingsClose").addEventListener("click", function(){
    var v = $("nameInput").value.trim().slice(0, 24);
    if (v && v !== myName) {
      myName = v; ctxApp.name = v;
      try { localStorage.setItem("oc-name", v); } catch (e) {}
      paintLocal(); renderPeople(); broadcastState({name: v});
    }
    $("settingsPop").hidden = true;
  });
  $("micSel").addEventListener("change", function(e){ if (e.target.value) switchDevice("mic", e.target.value); });
  $("camSel").addEventListener("change", function(e){ if (e.target.value) switchDevice("cam", e.target.value); });
  $("audioGate").addEventListener("click", passGate);
  window.addEventListener("pagehide", function(){ try { ctxApp.sock.close(1000, "bye"); } catch (e) {} });
}
function syncTabs(){
  $("tabChatBtn").classList.toggle("on", !$("chatPane").hidden);
  $("tabPeopleBtn").classList.toggle("on", !$("peoplePane").hidden);
}

/* ================= test bot (headless end-to-end) ================= */
var bots = {}, botCtx = null, botTimers = [];
function spawnBot(makeSock, opts){
  opts = opts || {};
  var cv = document.createElement("canvas");
  cv.width = 320; cv.height = 240;
  var cx = cv.getContext("2d");
  var frame = 0;
  botTimers.push(setInterval(function(){
    frame++;
    cx.fillStyle = "#102030"; cx.fillRect(0, 0, 320, 240);
    cx.fillStyle = "#ff5c39"; cx.fillRect((frame * 7) % 280, 100, 40, 40);
    cx.fillStyle = "#fff"; cx.font = "20px sans-serif";
    cx.fillText("bot " + frame, 10, 30);
  }, 120));
  var vs = null;
  try { vs = cv.captureStream(10); } catch (e) { return null; }
  var stream = new MediaStream();
  if (!opts.noMedia) vs.getVideoTracks().forEach(function(t){ stream.addTrack(t); });
  var AC = null;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    var osc = AC.createOscillator(); osc.frequency.value = 220;
    var g = AC.createGain(); g.gain.value = 0.03;
    var dst = AC.createMediaStreamDestination();
    osc.connect(g); g.connect(dst); osc.start();
    if (!opts.noMedia) dst.stream.getAudioTracks().forEach(function(t){ stream.addTrack(t); });
    else bot._acExtra = {osc: osc, dst: dst};
  } catch (e) { AC = null; }
  var id = "bot-" + rid();
  var bot = {id: id, ctx: null, ac: AC, lastChat: null, cv: cv, files: []};
  var ctx = makeCtx({id: id, name: "TestBot", stream: stream, ui: false, onEvent: function(ev){
    if (ev.k === "track" && ev.peer) {
      var v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.style.cssText = "width:2px;height:2px;position:fixed;left:-10px;top:-10px;";
      v.srcObject = ev.peer.stream;
      document.body.appendChild(v);
      ev.peer.videoEl = v;
      var pr = v.play(); if (pr && pr.catch) pr.catch(function(){});
    } else if (ev.k === "remove" && ev.peer && ev.peer.videoEl) {
      if (ev.peer.videoEl.parentNode) ev.peer.videoEl.parentNode.removeChild(ev.peer.videoEl);
    } else if (ev.k === "file") {
      ev.blob.arrayBuffer().then(function(buf){
        var bytes = new Uint8Array(buf), s = "";
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        bot.files.push({name: ev.name, size: ev.size, text: s});
      });
    } else if (ev.k === "chat") {
      bot.lastChat = ev.name + ": " + ev.text;
    }
  }});
  bot.ctx = ctx;
  bots[id] = bot; botCtx = bot;
  attachSocket(ctx, makeSock);
  return id;
}
/* loopback socket hub: mirrors the server protocol for emulator-free tests */
var testHub = null;
function makeLoopbackHub(){
  var conns = []; // {sock, id, name}
  function deliver(sock, o){
    var d = JSON.stringify(o);
    setTimeout(function(){ (sock._ml || []).forEach(function(f){ f({data: d}); }); }, 0);
  }
  function cast(except, o){
    conns.forEach(function(c){ if (c.sock !== except && c.id) deliver(c.sock, o); });
  }
  var hub = {
    join: function(sock){ conns.push({sock: sock, id: null, name: ""}); },
    leave: function(sock, code){
      for (var i = 0; i < conns.length; i++) {
        if (conns[i].sock === sock) {
          var dead = conns.splice(i, 1)[0];
          if (dead.id) cast(null, {t: "leave", id: dead.id});
          break;
        }
      }
      (sock._cl || []).forEach(function(f){ f({code: code || 1000}); });
    },
    route: function(sock, raw){
      var m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (!m || typeof m.t !== "string") return;
      var rec = null, i;
      for (i = 0; i < conns.length; i++) if (conns[i].sock === sock) rec = conns[i];
      if (!rec) return;
      if (m.t === "hi") {
        rec.id = m.id; rec.name = m.name || "Guest";
        if (!m.hb) {
          var roster = [];
          conns.forEach(function(c){ if (c.sock !== sock && c.id) roster.push({id: c.id, name: c.name}); });
          deliver(sock, {t: "roster", peers: roster});
          cast(sock, {t: "join", id: rec.id, name: rec.name});
        }
      } else if (m.t === "sig") {
        var tgt = null;
        conns.forEach(function(c){ if (c.id === m.to) tgt = c; });
        if (!tgt) deliver(sock, {t: "nop", id: m.to});
        else deliver(tgt.sock, {t: "sig", from: rec.id, kind: m.kind, payload: m.payload});
      } else if (m.t === "chat") {
        if (rec.id && typeof m.text === "string" && m.text)
          cast(null, {t: "chat", id: rec.id, name: rec.name, text: m.text.slice(0, 500), ts: Date.now()});
      } else if (m.t === "react") {
        if (rec.id && typeof m.emo === "string" && m.emo)
          cast(null, {t: "react", id: rec.id, emo: m.emo.slice(0, 8)});
      } else if (m.t === "state") {
        var out = {t: "state", id: rec.id};        if (typeof m.name === "string") { rec.name = m.name.slice(0, 24); out.name = rec.name; }
        ["hand", "mic", "cam", "sharing"].forEach(function(f){ if (typeof m[f] === "boolean") out[f] = m[f]; });
        cast(null, out);
      }
    },
    sock: function(){
      var sock = {_ml: [], _ol: [], _cl: []};
      sock.addEventListener = function(t, f){
        if (t === "message") sock._ml.push(f);
        else if (t === "open") sock._ol.push(f);
        else if (t === "close") sock._cl.push(f);
      };
      sock.send = function(d){ hub.route(sock, String(d)); };
      sock.close = function(){ hub.leave(sock, 1000); };
      hub.join(sock);
      setTimeout(function(){ sock._ol.forEach(function(f){ f({}); }); }, 0);
      return sock;
    }
  };
  return hub;
}
function testSock(){
  if (!testHub) testHub = makeLoopbackHub();
  return testHub.sock();
}
/* late-track test hook: attach fresh media to a trackless bot (screenshare path) */
function botAddTrack(id){
  var b = bots[id];
  if (!b || !b.ctx) return false;
  var added = false;
  try {
    var vs = b.cv.captureStream(10);
    vs.getVideoTracks().forEach(function(t){ b.ctx.stream.addTrack(t); added = true; });
  } catch (e) {}
  if (b._acExtra && b._acExtra.dst) {
    b._acExtra.dst.stream.getAudioTracks().forEach(function(t){ b.ctx.stream.addTrack(t); added = true; });
  }
  if (added) resyncOutboundCtx(b.ctx, b.ctx.stream.getTracks(), b.ctx.stream);
  return added;
}
function describeCtx(ctx){
  var out = {me: ctx.me.slice(0, 8), peers: []};
  ctx.peers.forEach(function(P){
    out.peers.push({id: P.id.slice(0, 8), pc: P.pc ? P.pc.connectionState : null,
      sig: P.pc ? P.pc.signalingState : null,
      vtracks: P.stream ? P.stream.getVideoTracks().length : 0,
      atracks: P.stream ? P.stream.getAudioTracks().length : 0,
      w: P.videoEl ? P.videoEl.videoWidth : -1});
  });
  return out;
}
function botInfo(id){
  if (id && bots[id]) { var o = describeCtx(bots[id].ctx); o.lastChat = bots[id].lastChat; return o; }
  var all = {};
  Object.keys(bots).forEach(function(k){
    all[k.slice(0, 8)] = describeCtx(bots[k].ctx);
    all[k.slice(0, 8)].lastChat = bots[k].lastChat;
    all[k.slice(0, 8)].files = bots[k].files.map(function(f){ return {name: f.name, size: f.size, text: f.text}; });
  });
  return all;
}
window.__call = {
  me: function(){ return ME; },
  peers: function(){
    return peerList().map(function(P){
      return {id: P.id.slice(0, 6), pc: P.pc ? P.pc.connectionState : null,
        vtracks: P.stream ? P.stream.getVideoTracks().length : 0,
        w: P.videoEl ? P.videoEl.videoWidth : -1};
    });
  },
  chat: function(t){ sendMsg(ctxApp, {t: "chat", text: String(t).slice(0, 500)}); },
  spawnBot: spawnBot,
  testBot: function(){ return spawnBot(testSock); },
  testBotQuiet: function(){ return spawnBot(testSock, {noMedia: true}); },
  botAddTrack: botAddTrack,
  botInfo: botInfo,
  botSay: function(id, t){
    if (bots[id]) sendMsg(bots[id].ctx, {t: "chat", text: String(t).slice(0, 500)});
  },
  botSendFile: function(id, text, name){
    var b = bots[id];
    if (!b || !b.ctx) return 0;
    var f;
    try { f = new File([String(text)], String(name || "bot.txt")); }
    catch (e) { return 0; }
    var fid = "f" + (++fileSeq) + "-t", n = 0;
    b.ctx.peers.forEach(function(P){
      if (dcOpen(P)) { n++; sendFileTo(P, fid, f); }
    });
    return n;
  },
  joinTestHub: function(){ if (!ctxApp._hub) { ctxApp._hub = true; if (ctxApp._rt) clearTimeout(ctxApp._rt); attachSocket(ctxApp, testSock); } },
  stopBot: function(id){
    function stopOne(b){
      if (!b) return;
      if (b.ctx) {
        b.ctx.closed = true;
        if (b.ctx.hbTimer) clearInterval(b.ctx.hbTimer);
        try { b.ctx.sock.close(1000, "bot done"); } catch (e) {}
        Array.from(b.ctx.peers.keys()).forEach(function(pid){ dropPeer(b.ctx, pid); });
      }
      if (b.ac) { try { b.ac.close(); } catch (e) {} }
      delete bots[b.id];
      if (botCtx === b) botCtx = null;
    }
    if (id && bots[id]) stopOne(bots[id]);
    else if (!id) { Object.keys(bots).forEach(function(k){ stopOne(bots[k]); }); botTimers = []; }
  }
};

/* ================= boot ================= */
async function boot(){
  wire();
  buildLocalTile();
  renderPeople();
  updateCount();
  var mode = await initMedia();
  ctxApp.stream = localStream;
  if (localStream) {
    var vts = localStream.getVideoTracks(), ats = localStream.getAudioTracks();
    micTrack = ats[0] || null; camTrack = vts[0] || null;
    localVideo.srcObject = localStream;
    fillDevices();
  }
  paintLocal();
  if (mode === "none") showErr("Camera and microphone are unavailable — you joined as a spectator. You can still watch, listen and chat once someone shares media.");
  attachSocket(ctxApp);
  updateCount();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
