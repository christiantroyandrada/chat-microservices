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

## Browser transport

Go is the browser's only live transport. Forward the same-origin `/ws/v1` path to the relay. Messages and receipts remain authenticated REST commands. Receipt events prompt a status refresh from the chat API. After reconnect, the browser refreshes conversations and the latest 50 messages in the open conversation.

Typing and presence use Go. Presence requires a stored conversation between the accounts and counts tabs on the same relay instance. It shows as unavailable during reconnect. Typing expires after three seconds without a refresh.

Old Socket.IO tabs require one refresh after cutover. The retired endpoint returns 404.

To run the isolated test, use the committed frontend and backend worktrees. From the backend worktree, run:

```sh
node tests/fullstack/run.mjs --start-fixture --go-websocket --frontend-dir /path/to/frontend-worktree
```

Without `--go-websocket`, the fixture checks encrypted persistence and account isolation. With it, the fixture checks Go events and reconnects. Both modes start Go. Run each mode in a fresh fixture to preserve the production authentication rate limits.

Add `--rehearse-rollback` to restart Go before the browser test. The fixture restores the prior Go-compatible frontend while Go stays running. It waits one minute between flows for the shared prekey rate limit and checks that stored ciphertext remains unchanged.

Add `--rollback-frontend-sha <full-commit-sha>` to restore a prior frontend image during the rehearsal. The fixture builds the prior image before the test and starts it by local image ID. It records both image IDs after Go delivery and database checks pass.

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


## Release and rollback

Both workflows require Go. Configure distinct `GO_WS_SESSION_KEY` and `GO_WS_BRIDGE_TOKEN` values in production Infisical. Keep them available during rollback.

The backend records the relay's immutable digest. It cannot remove Go while the current frontend requires it. The frontend release checks the recorded relay and gateway before replacement. Recorded image and flag metadata remain available for automatic rollback to a verified prior image.

Before release, verify encrypted delivery, account changes, restart, capacity, and recovery. Rehearse rollback with a Go-compatible frontend. Run independent correctness, failure, and structure reviews on the final candidate.

During a Go outage, live delivery waits for recovery. REST message acceptance remains available. The browser retrieves missed messages after reconnect.
