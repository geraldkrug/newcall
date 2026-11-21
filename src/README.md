# newcall — one-link video chat

A MiroTalk P2P-style clone with no rooms: everyone who opens the generator URL
joins the same live call. Media is peer-to-peer WebRTC; the server plugin only
routes signaling (presence, SDP/ICE, chat, state broadcasts).

## Features

- **One shared call**: no rooms, no lobby — every visitor joins the same mesh.
- P2P video/audio (full mesh), screen share, mic/cam toggles, per-person local
  mute (click their tile — essential in a public link), speaking highlight.
- Chat + unread badge, people list, raise hand, emoji reactions, **file sharing**
  (mesh DataChannels, 50 MB cap, progress + download links in chat).
- Instant join with camera (audio-only / spectator fallbacks), name + mic/cam
  pickers, copy-link button, leave/rejoin, reconnect w/ backoff, audio-autoplay
  gate, 4403 embed-blocked notice.
- `?turn=user:pass@host:port` (or `?turns=`) adds a TURN relay for strict NATs.

## Files

- `index.html` — server signaling router in the FIRST
  `<script type="text/x-server-plugin">`, then markup for the call UI
- `src/call.js` — client: media, full-mesh RTCPeerConnection, chat, screen
  share, reconnect, test bot (`window.__call`)
- `src/call.css` — dark call UI
- `main.pjs` — `$meta` + `createServerSocket` import

## Protocol (topic `call`, JSON)

- `hi {id,name}` → server registers, replies `roster`, publishes `join`.
  `hi {…,hb:1}` heartbeat: refresh only. Bad id collision → `taken`.
- `sig {to,kind,payload}` → directed relay; unknown target → `nop`.
- `chat {text}` (≤500 chars) → broadcast with server timestamp.
- `state {name?,hand?,mic?,cam?,sharing?}` → broadcast.
- `react {emo}` → broadcast iff emo is in the allowlist.
- Server subscribes every conn to `call` on open (clients have no sub API).

## WebRTC

- Higher peer id offers; lower is polite (rollback on rejoin races).
- ICE: Google + Cloudflare + Twilio STUN; `?turn=user:pass@host:port`
  (or `?turns=`) adds a TURN relay.
- `outTracks()` = mic + screen-while-sharing else camera; `resyncOutbound()`
  reconciles all senders (replace/add/remove-ended) — used on share, device
  switch, and media init.
- Audio autoplay gate: remote videos start muted until the first tap/keypress.

## Testing (headless, no camera)

- App boots as spectator when getUserMedia fails — exercise the UI through that.
- `__call.spawnBot()` creates a second in-page client (own socket + id) with a
  canvas video stream + oscillator audio stream; `__call.botInfo()` reports
  both sides' PC states. `__call.stopBot()` tears it down.
- Emulator is single-tab: two sockets in one page share state, so full signaling
  + real SDP/ICE exchange + media flow can be tested end to end via page_eval.
