package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRelay(t *testing.T) {
	const (
		alice = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		bob   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
		carol = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		token = "fixture-bridge-token-for-local-tests"
	)
	users := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("jwt")
		if r.URL.Path != "/me" || err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch cookie.Value {
		case "bob":
			fmt.Fprintf(w, `{"status":200,"data":{"id":%q}}`, bob)
		case "carol":
			fmt.Fprintf(w, `{"status":200,"data":{"id":%q}}`, carol)
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer users.Close()

	chat := httptest.NewUnstartedServer(nil)
	origin := "http://" + chat.Listener.Addr().String()
	chat.Config.Handler = newRelay(origin, users.URL+"/me", token)
	chat.Start()
	defer chat.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dial := func(cookie, site string) (*websocket.Conn, *http.Response, error) {
		header := http.Header{"Origin": {site}}
		if cookie != "" {
			header.Set("Cookie", "jwt="+cookie)
		}
		return websocket.Dial(ctx, "ws"+strings.TrimPrefix(chat.URL, "http")+"/ws/v1",
			&websocket.DialOptions{HTTPHeader: header})
	}
	for _, tt := range []struct {
		cookie, origin string
		status         int
	}{
		{"", origin, http.StatusUnauthorized},
		{"unknown", origin, http.StatusUnauthorized},
		{"bob", "", http.StatusForbidden},
		{"bob", "https://other.example", http.StatusForbidden},
	} {
		c, res, err := dial(tt.cookie, tt.origin)
		if c != nil {
			c.CloseNow()
		}
		if err == nil || res == nil || res.StatusCode != tt.status {
			t.Fatalf("handshake returned %v, %v, want HTTP %d", res, err, tt.status)
		}
	}
	connect := func(user string) *websocket.Conn {
		t.Helper()
		c, _, err := dial(user, origin)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.CloseNow() })
		_, ready, err := c.Read(ctx)
		if err != nil || string(ready) != `{"type":"ready"}` {
			t.Fatalf("ready frame: %s, %v", ready, err)
		}
		return c
	}
	bobSocket := connect("bob")
	carolSocket := connect("carol")
	post := func(secret, recipient, id, ciphertext string, want int) {
		t.Helper()
		body, err := json.Marshal(map[string]string{
			"id": id, "senderId": alice, "receiverId": recipient, "message": ciphertext,
			"status": "NotDelivered", "createdAt": "2026-11-17T08:00:00Z",
		})
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, chat.URL+"/internal/messages", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		res, err := chat.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("post returned %d, want %d", res.StatusCode, want)
		}
	}
	const ciphertext = " { \"__encrypted\": true, \"body\": \"QUJD\" } "
	const first = "11111111-1111-4111-8111-111111111111"
	const second = "22222222-2222-4222-8222-222222222222"
	post("wrong", bob, first, ciphertext, http.StatusUnauthorized)
	post(token, bob, first, "plaintext", http.StatusBadRequest)
	post(token, bob, first, ciphertext, http.StatusNoContent)
	post(token, carol, second, ciphertext, http.StatusNoContent)

	read := func(c *websocket.Conn, id, recipient string) {
		t.Helper()
		_, body, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var frame struct {
			Type string
			Data struct {
				ID, SenderID, ReceiverID, Message, Status string
			}
		}
		if err := json.Unmarshal(body, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "message" || frame.Data.ID != id || frame.Data.SenderID != alice ||
			frame.Data.ReceiverID != recipient || frame.Data.Message != ciphertext ||
			frame.Data.Status != "NotDelivered" {
			t.Fatalf("unexpected frame: %s", body)
		}
	}
	read(bobSocket, first, bob)
	read(carolSocket, second, carol)
}
