package gate

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"
)

// Activity records when the app last served a request, for the operator's
// idle check (App runtime.idleTimeoutMinutes): it polls GET /activity on the
// health port and scales the App to zero once no request has arrived for the
// idle period. A request still in flight (a WebSocket, a streamed response)
// counts as activity until it ends.
type Activity struct {
	now      func() time.Time
	last     atomic.Int64 // unix seconds
	inFlight atomic.Int64
}

// NewActivity starts the clock at now: a freshly started pod counts as
// active, so an App woken from idle gets a whole idle period.
func NewActivity(now func() time.Time) *Activity {
	if now == nil {
		now = time.Now
	}
	a := &Activity{now: now}
	a.last.Store(now().Unix())
	return a
}

func (a *Activity) begin() {
	a.inFlight.Add(1)
	a.last.Store(a.now().Unix())
}

func (a *Activity) end() {
	a.last.Store(a.now().Unix())
	a.inFlight.Add(-1)
}

// LastRequest is when the last request started or ended, or now while one
// is still in flight.
func (a *Activity) LastRequest() time.Time {
	if a.inFlight.Load() > 0 {
		return a.now()
	}
	return time.Unix(a.last.Load(), 0)
}

// activityReport is the /activity body the operator reads.
type activityReport struct {
	LastRequest int64 `json:"lastRequest"`
	InFlight    int64 `json:"inFlight"`
}

func (a *Activity) serve(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(activityReport{
		LastRequest: a.LastRequest().Unix(),
		InFlight:    a.inFlight.Load(),
	})
}
