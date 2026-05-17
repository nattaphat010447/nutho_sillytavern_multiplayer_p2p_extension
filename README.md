# ST Multiplayer

**Version 3.4.1** — A peer-to-peer multiplayer extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

Multiple players collaborate with a single AI character in real time. Everyone types their message, clicks Ready, and the host merges all inputs into one combined message before sending it to the AI. No dedicated server required — connections are established directly between browsers via WebRTC.

---

## Features

### Core Gameplay

- **Ready-based turn system** — all players submit their messages independently; the round starts only when every player is ready.
- **Normal mode** — players can see each other's messages as ghost previews while typing.
- **Hidden mode** — only the ready count is shown; messages are revealed when the AI replies.
- **Player and Spectator roles** — spectators can watch without participating. The host can force any player into spectator mode.

### Room Management

- 6-digit room codes for easy sharing.
- Configurable player limit (default: 10).
- Optional room password, verified with SHA-256 hashing.
- Per-message character limit (optional).
- Host controls: kick players, force role changes, drag-to-reorder the player list, sort by ready time.

### Chat Synchronization

- Real-time diff-based sync — edits, deletions, and swipes on the host side are broadcast to all clients.
- Full chat sync for late joiners and after reconnection.
- Bot name and avatar masquerade — clients see the AI's name and avatar as if they were on the host's instance.

### In-Room Text Chat

- Separate chat panel for player communication (not sent to the AI).
- Grouped message bubbles, unread badge, and rate limiting.

### Reliability

- Auto-retry on PeerJS broker disconnect (3 attempts, 1s → 3s → 6s backoff) before giving up.
- Auto-reconnect with exponential backoff (2s → 5s → 10s, up to 3 attempts).
- Session snapshot stored in `sessionStorage` for recovery after tab freeze or crash.
- Heartbeat / keepalive with zombie client detection (90s timeout).
- Screen Wake Lock to prevent the browser from sleeping mid-session.
- Generation-failure recovery — if the AI fails to respond, the injected message is deleted and each player's typed text is restored so the round can be retried.

### Network / NAT Traversal

- Default: Google STUN (`stun.l.google.com:19302`).
- **Free Public TURN** via OpenRelay — one-click enable in the Network settings tab.
- **Server Packs** — shareable strings that encode a custom TURN/STUN server:
  - `STMP1` — plain base64url encoding.
  - `STMP2` — AES-GCM-256 encrypted with a PBKDF2-derived key (requires a passphrase to decode).
- Force-relay option to route all traffic through the TURN server.

### UX

- Replaces SillyTavern's Send button with a Ready button while in a room.
- Smart Enter-key handling: desktop sends on Enter, mobile inserts a newline.
- Panel theme: auto (follows SillyTavern), dark, or light.
- Toast notifications for connection events, errors, and status changes.

---

## Installation

In SillyTavern, open **Extensions > Install extension** and paste the repository URL:

```
https://github.com/nattaphar010447/nutho_sillytavern_multiplayer_p2p_extension
```

SillyTavern will download and register the extension automatically.

---

## Usage

### Hosting a room

1. Open a chat with an AI character in SillyTavern.
2. Open the **ST Multiplayer** panel.
3. Set your display name, choose a room mode (Normal / Hidden), and configure any optional settings.
4. Click **Create Room**.
5. Share the 6-digit room code with other players.

### Joining a room

1. Open the **ST Multiplayer** panel.
2. Enter your display name and the room code.
3. Click **Join Room** and confirm the warning — joining will replace your local chat history with the host's recent history.

### Playing

- Type your message in the SillyTavern input box.
- Click the Ready button (or press Enter on desktop) when done.
- Wait for all players to be ready. The host automatically merges all messages and sends them to the AI.
- Once the AI replies, a new round begins.

> The host's SillyTavern instance is the one that actually communicates with the AI. The host must remain connected for the session to continue.

---

## TURN / Server Configuration

Direct WebRTC connections work on most networks, but symmetric NAT (common on mobile networks and some corporate firewalls) requires a TURN relay.

### Free Public TURN (OpenRelay)

In the **Network** settings tab, click **Free Public TURN (OpenRelay)** to enable it. Credentials are generated automatically with a 24-hour TTL using the standard TURN REST API mechanism.

### Custom Server Pack

If you have your own TURN server:

1. Fill in the TURN URL, username, and password in the Network tab.
2. Click **Generate Pack** to produce an `STMP1` (plain) or `STMP2` (encrypted) string.
3. Share the string with other players. They paste it into their Network tab to use the same server.

For `STMP2`, both the generator and the recipient need the same passphrase (minimum 8 characters).

---

## Requirements

- SillyTavern.
- A modern browser with WebRTC support (Chrome, Firefox, Edge, Safari 15+).
- PeerJS is loaded automatically from `unpkg.com` at runtime — no manual installation needed.

---

## Known Limitations

- The host must stay online. If the host disconnects, clients attempt to reconnect for up to ~17 seconds before the session ends.
- Joining a room replaces the client's local chat display with the host's recent history (last 10 messages).
- The browser tab must remain open and active. Screen Wake Lock reduces the risk of the OS suspending the tab, but background throttling on mobile is not fully preventable.

---

## License

MIT License — Copyright (c) 2026 nattaphat010447. See [LICENSE](LICENSE) for the full text.

---

## Credits

- [PeerJS](https://peerjs.com/) — WebRTC peer-to-peer library used for all connections and data channels.
- [OpenRelay](https://openrelay.metered.ca/) — free public TURN server used by the one-click TURN option.
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) — the AI frontend this extension is built for.
