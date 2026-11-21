# newcall for g--dk.biz — install guide

You tested it working (Guest-9184 on two phones). This zip is the full source.

## What's inside

- `index.html` — the app (same code as your working test). The
  `<script type="text/x-server-plugin">` block at the top is Perchance-only;
  normal browsers ignore it, so the SAME file works on your own domain.
- `src/call.js` — WebRTC mesh client (video/audio, screen share, chat,
  reactions, files, reconnect). Supports `?signal=` (see below).
- `src/call.css`, `src/README.md`, `main.pjs` (Perchance wrapper, ignore on your host).

## Option A — fastest (recommended): point g--dk.biz at your Perchance link

1. Save/publish your generator, copy its URL: `https://perchance.org/YOUR-NAME`
2. At your registrar/host for `g--dk.biz`, add a redirect / forward:
   `https://g--dk.biz/` → `https://perchance.org/YOUR-NAME`
   (a 301 redirect or a landing button "Join call" linking there).
3. Done. Signaling stays free on Perchance, media stays P2P.

Do NOT iframe-embed the Perchance page: production sockets close with 4403
off perchance.org (the app shows a banner). Use a redirect or a plain link.

## Option B — full self-host on g--dk.biz (your own signaling)

You need HTTPS (camera/mic require secure context) + Node 18+.

1. Unzip this file on your server, e.g. `/var/www/newcall/`.
2. Serve the static files (`index.html` + `src/`) over HTTPS.
   Example nginx root: `root /var/www/newcall;`
3. Run signaling:
   ```
   npm install
   PORT=3000 node server.js
   ```
   Put it behind TLS so clients connect via `wss://`, e.g. nginx:
   `location /signal/ { proxy_pass http://127.0.0.1:3000/; proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }`
4. Open the app with your socket URL:
   `https://g--dk.biz/?signal=wss%3A%2F%2Fg--dk.biz%2Fsignal%2F`
   (the `signal` query param must be the wss URL, URL-encoded).
   Everyone opening THAT link joins the same call — same as before.
5. Optional TURN for strict networks: `?signal=...&turn=user:pass@host:port`
   (also `&turns=` for turns:). Without TURN most home/4G calls still connect.

## Notes

- No build step. No database. Signaling is ephemeral (restart = empty call).
- Files shared in chat go P2P over WebRTC, max 50 MB, never touch your server.
- Health check: `GET /health` → `ok`.
- If camera fails, the app joins as spectator (chat still works).
