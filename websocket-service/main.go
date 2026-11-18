package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	origin := os.Getenv("GO_WS_ORIGIN")
	sessionURL := os.Getenv("GO_WS_SESSION_URL")
	sessionKey := os.Getenv("GO_WS_SESSION_KEY")
	historyURL := os.Getenv("GO_WS_CHAT_HISTORY_URL")
	token := os.Getenv("GO_WS_BRIDGE_TOKEN")
	site, err := parseHTTPURL(origin)
	if err != nil || site.Path != "" {
		log.Fatal("GO_WS_ORIGIN must be an HTTP origin without a trailing slash")
	}
	if endpoint, err := parseHTTPURL(sessionURL); err != nil || endpoint.Path != "/internal/ws/session" {
		log.Fatal("GO_WS_SESSION_URL must be the private HTTP URL for /internal/ws/session")
	}
	if len(sessionKey) < 32 {
		log.Fatal("GO_WS_SESSION_KEY must contain at least 32 bytes")
	}
	if _, err := parseHTTPURL(historyURL); err != nil {
		log.Fatal("GO_WS_CHAT_HISTORY_URL must be the HTTP URL for the chat history endpoint")
	}
	if len(token) < 32 {
		log.Fatal("GO_WS_BRIDGE_TOKEN must contain at least 32 characters")
	}
	addr := os.Getenv("GO_WS_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8090"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	connections, cancelConnections := context.WithCancel(context.Background())
	defer cancelConnections()
	relay := newRelay(origin, sessionURL, historyURL, token, sessionKey)
	server := &http.Server{
		Addr:              addr,
		Handler:           relay,
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 << 10,
		BaseContext:       func(net.Listener) context.Context { return connections },
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		drained := relay.beginShutdown()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
			server.Close()
		}
		select {
		case <-drained:
		case <-shutdownCtx.Done():
			log.Print("WebSocket shutdown deadline reached")
			cancelConnections()
		}
	}()
	log.Printf("WebSocket relay listening on %s", addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-stopped
}

func parseHTTPURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" ||
		u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errors.New("invalid HTTP URL")
	}
	return u, nil
}
