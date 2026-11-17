# Go WebSocket relay

The relay delivers accepted chat messages to authenticated users. PostgreSQL stores the messages. The relay sends ciphertext to connected clients when the chat service can reach it.

## Run locally

Use Go 1.26 or later. From this directory, run `go test -race ./...`. Set these environment variables before you run `go run .`.

| Variable | Value |
| --- | --- |
| `GO_WS_ORIGIN` | Exact browser origin, without a trailing slash |
| `GO_WS_SESSION_URL` | URL of the user service's `/me` endpoint |
| `GO_WS_BRIDGE_TOKEN` | Shared secret of at least 32 bytes |
| `GO_WS_ADDR` | Listen address. Default is `127.0.0.1:8090` |

Set the same bridge token in the chat service. Set `GO_WS_BRIDGE_URL` there to the relay's `/internal/messages` endpoint. Keep that endpoint private.

Connect to `/ws/v1?expectedUserId=<id>` with the matching `jwt` session cookie. The relay sends a `ready` frame, then sends `message` frames for the authenticated recipient.

## Browser pilot

Set `PUBLIC_GO_WS_ENABLED=true` in the frontend runtime. Forward the same-origin `/ws/v1` path to the relay. The browser receives messages and receipt events through Go. Receipt events cause the browser to read current status from the chat API. The browser acknowledges delivery through the chat API. Socket.IO still handles typing and presence. Legacy clients still receive Socket.IO receipts. After reconnect, it refreshes the conversation list and fetches the latest 50 messages in the open conversation.

To run the isolated test, use the committed frontend and backend worktrees. From the backend worktree, run:

```sh
node tests/fullstack/run.mjs --start-fixture --go-websocket --frontend-dir /path/to/frontend-worktree
```
