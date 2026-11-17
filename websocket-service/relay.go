package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	maxConnections = 128
	queueSize      = 8
	maxMessageSize = 64 << 10
	writeTimeout   = 3 * time.Second
	sessionLimit   = 5 * time.Minute
)

var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type message struct {
	ID              string    `json:"id"`
	SenderID        string    `json:"senderId"`
	SenderUsername  string    `json:"senderUsername,omitempty"`
	ReceiverID      string    `json:"receiverId"`
	Ciphertext      string    `json:"message"`
	Status          string    `json:"status"`
	CreatedAt       time.Time `json:"createdAt"`
	ClientMessageID *string   `json:"clientMessageId,omitempty"`
}

func (m message) valid() bool {
	if !uuid.MatchString(m.ID) || !uuid.MatchString(m.SenderID) || !uuid.MatchString(m.ReceiverID) ||
		m.SenderID == m.ReceiverID || m.CreatedAt.IsZero() {
		return false
	}
	if m.ClientMessageID != nil && !uuid.MatchString(*m.ClientMessageID) {
		return false
	}
	switch m.Status {
	case "NotDelivered", "Delivered", "Seen":
	default:
		return false
	}
	var envelope struct {
		Encrypted bool    `json:"__encrypted"`
		Body      *string `json:"body"`
	}
	return json.Unmarshal([]byte(m.Ciphertext), &envelope) == nil && envelope.Encrypted && envelope.Body != nil
}

type subscriber struct {
	queue  chan []byte
	cancel context.CancelFunc
}

type relay struct {
	origin, sessionURL string
	bridgeAuth         [sha256.Size]byte
	httpClient         *http.Client
	slots              chan struct{}
	mu                 sync.Mutex
	subscribers        map[string]map[*subscriber]struct{}
}

func newRelay(origin, sessionURL, token string) http.Handler {
	r := &relay{
		origin:      origin,
		sessionURL:  sessionURL,
		bridgeAuth:  sha256.Sum256([]byte("Bearer " + token)),
		slots:       make(chan struct{}, maxConnections),
		subscribers: make(map[string]map[*subscriber]struct{}),
		httpClient: &http.Client{
			Timeout: 2 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/v1", r.connect)
	mux.HandleFunc("POST /internal/messages", r.bridge(r.publishMessage))
	mux.HandleFunc("POST /internal/receipts", r.bridge(r.publishReceipt))
	return mux
}

func (r *relay) userID(req *http.Request) (string, int) {
	cookie, err := req.Cookie("jwt")
	if err != nil || cookie.Value == "" {
		return "", http.StatusUnauthorized
	}
	check, err := http.NewRequestWithContext(req.Context(), http.MethodGet, r.sessionURL, nil)
	if err != nil {
		return "", http.StatusServiceUnavailable
	}
	check.AddCookie(cookie)
	res, err := r.httpClient.Do(check)
	if err != nil {
		return "", http.StatusServiceUnavailable
	}
	defer res.Body.Close()

	switch res.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
		return "", http.StatusUnauthorized
	case http.StatusOK:
	default:
		return "", http.StatusServiceUnavailable
	}
	var session struct {
		Status int
		Data   struct{ ID string }
	}
	err = json.NewDecoder(io.LimitReader(res.Body, 8<<10)).Decode(&session)
	if err != nil || session.Status != http.StatusOK || !uuid.MatchString(session.Data.ID) {
		return "", http.StatusServiceUnavailable
	}
	return session.Data.ID, http.StatusOK
}

func (r *relay) connect(w http.ResponseWriter, req *http.Request) {
	if origins := req.Header.Values("Origin"); len(origins) != 1 || origins[0] != r.origin {
		http.Error(w, "origin forbidden", http.StatusForbidden)
		return
	}
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		http.Error(w, "connection limit", http.StatusServiceUnavailable)
		return
	}
	id, status := r.userID(req)
	if status != http.StatusOK {
		http.Error(w, http.StatusText(status), status)
		return
	}
	expectedOwners := req.URL.Query()["expectedUserId"]
	if len(expectedOwners) != 1 || expectedOwners[0] != id {
		http.Error(w, "session does not match the expected user", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: []string{r.origin}})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	ctx, cancel := context.WithTimeout(req.Context(), sessionLimit)
	defer cancel()
	conn.SetReadLimit(512)

	sub := &subscriber{queue: make(chan []byte, queueSize), cancel: cancel}
	r.mu.Lock()
	if r.subscribers[id] == nil {
		r.subscribers[id] = make(map[*subscriber]struct{})
	}
	r.subscribers[id][sub] = struct{}{}
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		delete(r.subscribers[id], sub)
		if len(r.subscribers[id]) == 0 {
			delete(r.subscribers, id)
		}
	}()

	write := func(data []byte) error {
		ctx, cancel := context.WithTimeout(ctx, writeTimeout)
		defer cancel()
		return conn.Write(ctx, websocket.MessageText, data)
	}
	if err := write([]byte(`{"type":"ready"}`)); err != nil {
		return
	}
	go func() {
		defer cancel()
		r.readTyping(ctx, conn, id)
	}()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-sub.queue:
			if err := write(data); err != nil {
				return
			}
		case <-heartbeat.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (r *relay) readTyping(ctx context.Context, conn *websocket.Conn, userID string) {
	var window time.Time
	var count int
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		now := time.Now()
		if now.Sub(window) >= time.Second {
			window, count = now, 0
		}
		count++
		if count > 8 {
			return
		}
		var input struct {
			Type       string `json:"type"`
			ReceiverID string `json:"receiverId"`
			IsTyping   *bool  `json:"isTyping"`
		}
		if kind != websocket.MessageText || !decodeJSON(bytes.NewReader(data), &input) ||
			input.Type != "typing" || input.IsTyping == nil || !uuid.MatchString(input.ReceiverID) ||
			input.ReceiverID == userID {
			continue
		}
		r.fanout(input.ReceiverID, "typing", struct {
			UserID   string `json:"userId"`
			IsTyping bool   `json:"isTyping"`
		}{userID, *input.IsTyping})
	}
}

type receipt struct {
	Type      string `json:"type"`
	UserID    string `json:"userId"`
	By        string `json:"by"`
	MessageID string `json:"messageId,omitempty"`
}

func (r *relay) bridge(publish http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		auth := sha256.Sum256([]byte(req.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(auth[:], r.bridgeAuth[:]) != 1 {
			http.Error(w, "bridge authorization required", http.StatusUnauthorized)
			return
		}
		publish(w, req)
	}
}

func decode(w http.ResponseWriter, req *http.Request, dst any) bool {
	return decodeJSON(http.MaxBytesReader(w, req.Body, maxMessageSize), dst)
}

func decodeJSON(body io.Reader, dst any) bool {
	d := json.NewDecoder(body)
	d.DisallowUnknownFields()
	return d.Decode(dst) == nil && errors.Is(d.Decode(&struct{}{}), io.EOF)
}

func (r *relay) publishMessage(w http.ResponseWriter, req *http.Request) {
	var m message
	if !decode(w, req, &m) || !m.valid() {
		http.Error(w, "invalid message", http.StatusBadRequest)
		return
	}
	r.publish(w, m.ReceiverID, "message", m)
}

func (r *relay) publishReceipt(w http.ResponseWriter, req *http.Request) {
	var event receipt
	if !decode(w, req, &event) || !uuid.MatchString(event.UserID) ||
		!uuid.MatchString(event.By) || event.UserID == event.By ||
		!(event.Type == "read" && event.MessageID == "" ||
			event.Type == "delivered" && uuid.MatchString(event.MessageID)) {
		http.Error(w, "invalid receipt", http.StatusBadRequest)
		return
	}
	r.publish(w, event.UserID, "receipt", event)
}

func (r *relay) publish(w http.ResponseWriter, userID, kind string, data any) {
	if err := r.fanout(userID, kind, data); err != nil {
		http.Error(w, "invalid event", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (r *relay) fanout(userID, kind string, data any) error {
	frame, err := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{kind, data})
	if err != nil {
		return err
	}
	r.mu.Lock()
	for sub := range r.subscribers[userID] {
		select {
		case sub.queue <- frame:
		default:
			if kind != "typing" {
				sub.cancel()
			}
		}
	}
	r.mu.Unlock()
	return nil
}
