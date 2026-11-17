package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
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
		case "alice":
			fmt.Fprintf(w, `{"status":200,"data":{"id":%q}}`, alice)
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
	dial := func(cookie, site, owner string) (*websocket.Conn, *http.Response, error) {
		header := http.Header{"Origin": {site}}
		if cookie != "" {
			header.Set("Cookie", "jwt="+cookie)
		}
		return websocket.Dial(ctx, "ws"+strings.TrimPrefix(chat.URL, "http")+"/ws/v1?expectedUserId="+owner,
			&websocket.DialOptions{HTTPHeader: header})
	}
	for _, tt := range []struct {
		cookie, origin, owner string
		status                int
	}{
		{"", origin, bob, http.StatusUnauthorized},
		{"unknown", origin, bob, http.StatusUnauthorized},
		{"bob", "", bob, http.StatusForbidden},
		{"bob", "https://other.example", bob, http.StatusForbidden},
		{"bob", origin, carol, http.StatusForbidden},
		{"bob", origin, "", http.StatusForbidden},
	} {
		c, res, err := dial(tt.cookie, tt.origin, tt.owner)
		if c != nil {
			c.CloseNow()
		}
		if err == nil || res == nil || res.StatusCode != tt.status {
			t.Fatalf("handshake returned %v, %v, want HTTP %d", res, err, tt.status)
		}
	}
	connect := func(user string) *websocket.Conn {
		t.Helper()
		owner := map[string]string{"alice": alice, "bob": bob, "carol": carol}[user]
		c, _, err := dial(user, origin, owner)
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
	postJSON := func(path, secret string, body map[string]string, want int) {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, chat.URL+path, bytes.NewReader(encoded))
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
	post := func(secret, recipient, id, ciphertext string, want int) {
		t.Helper()
		postJSON("/internal/messages", secret, map[string]string{
			"id": id, "senderId": alice, "receiverId": recipient, "message": ciphertext,
			"status": "NotDelivered", "createdAt": "2026-11-17T08:00:00Z",
		}, want)
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

	delivered := map[string]string{"type": "delivered", "userId": bob, "by": alice, "messageId": first}
	seen := map[string]string{"type": "read", "userId": carol, "by": alice}
	invalid := map[string]string{"type": "delivered", "userId": carol, "by": alice}
	postJSON("/internal/receipts", "wrong", delivered, http.StatusUnauthorized)
	postJSON("/internal/receipts", token, invalid, http.StatusBadRequest)
	postJSON("/internal/receipts", token, delivered, http.StatusNoContent)
	postJSON("/internal/receipts", token, seen, http.StatusNoContent)
	for _, tt := range []struct {
		socket *websocket.Conn
		want   map[string]string
	}{{bobSocket, delivered}, {carolSocket, seen}} {
		_, body, err := tt.socket.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var frame struct {
			Type string
			Data map[string]string
		}
		if err := json.Unmarshal(body, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "receipt" || !maps.Equal(frame.Data, tt.want) {
			t.Fatalf("unexpected receipt: %s", body)
		}
	}

	for _, payload := range []string{
		fmt.Sprintf(`{"type":"typing","receiverId":%q,"userId":%q,"isTyping":true}`, carol, alice),
		fmt.Sprintf(`{"type":"typing","receiverId":%q}`, carol),
		fmt.Sprintf(`{"type":"typing","receiverId":%q,"isTyping":true}`, carol),
		fmt.Sprintf(`{"type":"typing","receiverId":%q,"isTyping":false}`, carol),
	} {
		if err := bobSocket.Write(ctx, websocket.MessageText, []byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	for _, typing := range []bool{true, false} {
		_, body, err := carolSocket.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		want := fmt.Sprintf(`{"type":"typing","data":{"userId":%q,"isTyping":%t}}`, bob, typing)
		if string(body) != want {
			t.Fatalf("typing frame = %s, want %s", body, want)
		}
	}

	post(token, bob, first, ciphertext, http.StatusNoContent)
	read(bobSocket, first, bob)

	watch := func(id string) {
		t.Helper()
		data := fmt.Appendf(nil, `{"type":"watchPresence","userId":%q}`, id)
		if err := bobSocket.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	presence := func(id string, online bool) {
		t.Helper()
		_, body, err := bobSocket.Read(ctx)
		want := fmt.Sprintf(`{"type":"presence","data":{"userId":%q,"online":%t}}`, id, online)
		if err != nil || string(body) != want {
			t.Fatalf("presence frame = %s, %v; want %s", body, err, want)
		}
	}
	watch(alice)
	presence(alice, false)
	aliceSocket := connect("alice")
	presence(alice, true)
	aliceOtherTab := connect("alice")
	if err := aliceSocket.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	watch(alice)
	presence(alice, true)
	if err := aliceOtherTab.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	presence(alice, false)
	connect("alice")
	presence(alice, true)
	watch(carol)
	presence(carol, true)
}
