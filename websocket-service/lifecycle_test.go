package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testAccount = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const testSessionKey = "fixture-session-key-for-tests-only"

func fixtureSessions(t *testing.T) string {
	t.Helper()
	sessions := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("jwt")
		if err != nil || cookie.Value != "fixture-session" || r.URL.Path != "/internal/ws/session" ||
			r.Header.Get("X-Relay-Session-Key") != testSessionKey {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		fmt.Fprintf(w, `{"status":200,"data":{"id":%q}}`, testAccount)
	}))
	t.Cleanup(sessions.Close)
	return sessions.URL
}

func dialFixture(ctx context.Context, site string) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(site, "http")+"/ws/v1?expectedUserId="+testAccount,
		&websocket.DialOptions{HTTPHeader: http.Header{
			"Origin": {site},
			"Cookie": {"jwt=fixture-session"},
		}})
}

func requireReady(t *testing.T, ctx context.Context, conn *websocket.Conn) {
	t.Helper()
	_, frame, err := conn.Read(ctx)
	if err != nil || string(frame) != `{"type":"ready"}` {
		t.Fatalf("ready frame = %s, %v", frame, err)
	}
}

func TestRelayCapacity(t *testing.T) {
	sessions := fixtureSessions(t)
	server := httptest.NewUnstartedServer(nil)
	site := "http://" + server.Listener.Addr().String()
	server.Config.Handler = newRelay(site, sessions+"/internal/ws/session", sessions+"/get", strings.Repeat("x", 32), testSessionKey)
	server.Start()
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	open := func() *websocket.Conn {
		t.Helper()
		conn, _, err := dialFixture(ctx, site)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		requireReady(t, ctx, conn)
		return conn
	}

	first := open()
	for i := 1; i < maxConnections; i++ {
		open()
	}
	conn, res, err := dialFixture(ctx, site)
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || res == nil || res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("connection above limit = %v, %v; want 503", res, err)
	}
	if err := first.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	for {
		conn, res, err = dialFixture(ctx, site)
		if err == nil {
			t.Cleanup(func() { conn.CloseNow() })
			requireReady(t, ctx, conn)
			break
		}
		if res == nil || res.StatusCode != http.StatusServiceUnavailable || ctx.Err() != nil {
			t.Fatalf("connection after release = %v, %v", res, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAnonymousReadinessRequiresSessionDependency(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusNotFound, http.StatusOK, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			session := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Header.Get("X-Relay-Session-Key") != testSessionKey {
					t.Error("readiness did not send the private session key")
				}
				w.WriteHeader(status)
			}))
			defer session.Close()
			relay := newRelay("http://fixture", session.URL+"/internal/ws/session", session.URL+"/get", strings.Repeat("x", 32), testSessionKey)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, got := relay.userID(ctx, nil)
			want := http.StatusServiceUnavailable
			if status == http.StatusUnauthorized {
				want = http.StatusUnauthorized
			}
			if got != want {
				t.Fatalf("readiness = %d, want %d for session status %d", got, want, status)
			}
		})
	}
}

func TestSlowSubscriber(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	slow := &subscriber{queue: make(chan []byte, queueSize), cancel: cancel}
	healthy := &subscriber{queue: make(chan []byte, queueSize)}
	r := &relay{subscribers: map[string]map[*subscriber]struct{}{testAccount: {slow: {}, healthy: {}}}}
	for range queueSize {
		slow.queue <- []byte("queued")
	}
	if err := r.fanout(testAccount, "typing", true); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("discarding a typing frame disconnected the slow subscriber")
	}
	if err := r.fanout(testAccount, "message", "fixture"); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != context.Canceled {
		t.Fatal("a full queue did not disconnect the slow subscriber")
	}
	for _, want := range []string{`{"type":"typing","data":true}`, `{"type":"message","data":"fixture"}`} {
		select {
		case got := <-healthy.queue:
			if string(got) != want {
				t.Fatalf("healthy frame = %s, want %s", got, want)
			}
		default:
			t.Fatalf("healthy subscriber did not receive %s", want)
		}
	}
}

func TestRelayProcessRestart(t *testing.T) {
	if os.Getenv("CHAT_TEST_RELAY_CHILD") == "1" {
		main()
		return
	}
	sessions := fixtureSessions(t)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	site := "http://" + addr
	start := func() (*exec.Cmd, <-chan error, *websocket.Conn) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestRelayProcessRestart$")
		cmd.Env = append(os.Environ(),
			"CHAT_TEST_RELAY_CHILD=1",
			"GO_WS_ADDR="+addr,
			"GO_WS_ORIGIN="+site,
			"GO_WS_SESSION_URL="+sessions+"/internal/ws/session",
			"GO_WS_SESSION_KEY="+testSessionKey,
			"GO_WS_CHAT_HISTORY_URL="+sessions+"/get",
			"GO_WS_BRIDGE_TOKEN="+strings.Repeat("x", 32),
		)
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		exited := make(chan error, 1)
		go func() {
			defer close(exited)
			exited <- cmd.Wait()
		}()
		t.Cleanup(func() {
			cmd.Process.Kill()
			<-exited
		})
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		for {
			conn, _, err := dialFixture(ctx, site)
			if err == nil {
				t.Cleanup(func() { conn.CloseNow() })
				requireReady(t, ctx, conn)
				return cmd, exited, conn
			}
			select {
			case childErr := <-exited:
				t.Fatalf("relay exited during startup: %v", childErr)
			case <-ctx.Done():
				t.Fatalf("relay did not accept a connection: %v", err)
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	stop := func(cmd *exec.Cmd, exited <-chan error, conn *websocket.Conn) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
			t.Fatal(err)
		}
		_, _, err := conn.Read(ctx)
		if websocket.CloseStatus(err) != websocket.StatusGoingAway {
			t.Fatalf("relay close = %v, want going-away status", err)
		}
		select {
		case err := <-exited:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("relay did not exit")
		}
	}
	cmd, exited, conn := start()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	idle, _, err := dialFixture(ctx, site)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { idle.CloseNow() })
	requireReady(t, ctx, idle)
	cancel()
	stop(cmd, exited, conn)

	cmd, exited, conn = start()
	ctx, cancel = context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	const messageID = "11111111-1111-4111-8111-111111111111"
	body := fmt.Sprintf(`{"id":%q,"senderId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","receiverId":%q,"message":"{\"__encrypted\":true,\"body\":\"fixture\"}","status":"NotDelivered","createdAt":"2026-11-17T00:00:00Z"}`, messageID, testAccount)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, site+"/internal/messages", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 32))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("bridge status after restart = %d", response.StatusCode)
	}
	_, frame, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(frame), messageID) {
		t.Fatalf("frame after restart = %s, %v", frame, err)
	}
	stop(cmd, exited, conn)
}
