# Go WebSocket relay

The relay delivers accepted chat messages to authenticated users. PostgreSQL stores the messages. The relay sends ciphertext to connected clients when the chat service can reach it.

## Run locally

Use Go 1.26 or later. From this directory, run `go test -race ./...`. Set these environment variables before you run `go run .`.

| Variable | Value |
| --- | --- |
| `GO_WS_ORIGIN` | Exact browser origin, without a trailing slash |
| `GO_WS_SESSION_URL` | Private URL of the user service's `/internal/ws/session` endpoint |
| `GO_WS_SESSION_KEY` | Shared secret of at least 32 bytes. Set it on the relay and the user service. |
| `GO_WS_CHAT_HISTORY_URL` | URL of the chat service's `/get` endpoint, without a user ID |
| `GO_WS_BRIDGE_TOKEN` | Shared secret of at least 32 bytes |
| `GO_WS_ADDR` | Listen address. Default is `127.0.0.1:8090` |

Set the same bridge token in the chat service. Set `GO_WS_BRIDGE_URL` there to the relay's `/internal/messages` endpoint. Keep that endpoint private.

Use a separate secret for session checks. The user service still validates the browser's session cookie. Keep its internal session endpoint off the public gateway.

Connect to `/ws/v1?expectedUserId=<id>` with the matching `jwt` session cookie. The relay sends a `ready` frame, then sends `message` frames for the authenticated recipient.

## Browser pilot

Set `PUBLIC_GO_WS_ENABLED=true` in the frontend runtime. Forward the same-origin `/ws/v1` path to the relay. The browser receives messages and receipt events through Go. Receipt events cause the browser to read current status from the chat API. The browser acknowledges delivery through the chat API. Go pilot clients exchange typing with Go and Socket.IO clients. During rollout, the browser mirrors Go typing to Socket.IO and ignores mirrored copies in Go mode. The browser clears a typing indicator after three seconds without a refresh. Go pilot clients see online status after the chat API confirms a stored message between the accounts. Status includes Go tabs on the same relay instance and Socket.IO clients. Go presence authorization applies before the browser displays either source. It shows as unavailable while the connection reconnects. Legacy clients still receive Socket.IO receipts. After reconnect, it refreshes the conversation list and fetches the latest 50 messages in the open conversation.

To run the isolated test, use the committed frontend and backend worktrees. From the backend worktree, run:

```sh
node tests/fullstack/run.mjs --start-fixture --go-websocket --frontend-dir /path/to/frontend-worktree
```

Add `--rehearse-rollback` to restart the relay before the Go browser test. The fixture then stops Go, disables the frontend flag, and runs the Socket.IO browser test against the same database. It waits one minute between flows for the shared prekey rate limit to reset and checks that the stored Go messages survive the switch.

Add `--rollback-frontend-sha <full-commit-sha>` to restore a prior frontend image during the rehearsal. The fixture builds the prior image before the test and starts it by local image ID. It records both image IDs after Socket.IO delivery and database checks pass.

## Container image

Use Docker Buildx to build the relay image from the backend repo. The build runs the Go compiler on the build host's architecture.

```sh
docker buildx build --load -t chat-websocket:local websocket-service
```

The container listens on port `8090` as UID and GID `65532`. Use a private application network. Publish only `/ws/v1` through the gateway. Set the environment variables listed above. Run with a read-only root filesystem, drop all capabilities, and allow at least eight seconds for the container to stop. The Colima fixture builds this image from the committed source.

## Relay limits

The relay accepts up to 128 connections per instance. This count includes handshakes. Each connection has a queue of eight frames. If the queue is full, the relay drops typing frames. It disconnects the client if a message, receipt, or presence frame cannot enter the queue.

On SIGTERM, the relay stops admitting connections and sends a WebSocket going-away frame. It waits up to five seconds for connections to close. After reconnect, the browser reads missed messages from the chat API.

The Go tests verify these limits on loopback. They also stop and restart the relay on the same port. Use staging measurements to set the pilot limit on the VPS.

Add `--check-relay-capacity` to the isolated fixture command to check the cap through NGINX. The check opens 128 authenticated connections, verifies that the next connection receives HTTP 503, and confirms that closing one connection frees a slot.


## Before cutover

1. Verify the image and its digest in staging. Measure capacity through the staging gateway.
2. Verify account changes, restart, and recovery. Rehearse rollback to the verified prior release.
3. Run the adversarial review on the final candidate. Review correctness, failure modes, and structure independently. Resolve blocking findings and repeat affected checks before the VPS pilot.

Keep the Socket.IO compatibility path until the last legacy client moves to Go.
