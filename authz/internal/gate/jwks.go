package gate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

// KeyWatch reports readiness: it fetches the JWKS until one fetch returns
// at least one key, so a wrong AUTHZ_JWKS_URL never becomes Ready. Token
// verification keeps its own cache (go-oidc refetches on unknown key IDs).
type KeyWatch struct {
	URL    string
	Client *http.Client
	Every  time.Duration
	Log    *slog.Logger
	ready  atomic.Bool
}

// Ready reports whether a fetch has succeeded.
func (k *KeyWatch) Ready() bool { return k.ready.Load() }

// Run fetches until the first success or until ctx ends.
func (k *KeyWatch) Run(ctx context.Context) {
	for attempt := 1; ; attempt++ {
		err := k.fetch(ctx)
		if err == nil {
			k.ready.Store(true)
			k.Log.Info("realm signing keys fetched", "url", k.URL)
			return
		}
		if attempt == 1 || attempt%30 == 0 {
			k.Log.Warn("cannot fetch the realm's signing keys yet", "url", k.URL, "attempt", attempt, "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(k.Every):
		}
	}
}

func (k *KeyWatch) fetch(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.URL, nil)
	if err != nil {
		return err
	}
	resp, err := k.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %s", resp.Status)
	}
	var set struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil {
		return fmt.Errorf("decoding key set: %w", err)
	}
	if len(set.Keys) == 0 {
		return fmt.Errorf("key set is empty")
	}
	return nil
}
