package controller

import (
	"context"
	"errors"
	"html/template"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-logr/logr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// wakeThrottle limits how often the activator re-stamps WakeAnnotation on
// one App: the starting page reloads itself every few seconds.
const wakeThrottle = 15 * time.Second

// Activator serves the URL of every idle App (the NebariApp routes there
// while the App is scaled to zero, see idle.go). Each request stamps
// WakeAnnotation on the App, which the reconciler counts as activity, and
// gets a page that reloads itself until routing moves back to the App.
//
// It runs in every operator replica, leader or not, behind the chart's
// <release>-activator Service. The request has already passed the gateway's
// sign-in for a private App; the page names only the host the caller
// already knows.
type Activator struct {
	// Client reads Apps from the manager's cache and patches them.
	Client     client.Client
	AppsDomain string
	Addr       string
	Log        logr.Logger
	Now        func() time.Time
}

// NeedLeaderElection is false: every replica behind the Service must answer.
func (a *Activator) NeedLeaderElection() bool { return false }

// Start serves until ctx ends.
func (a *Activator) Start(ctx context.Context) error {
	srv := &http.Server{
		Addr:              a.Addr,
		Handler:           a,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	ln, err := net.Listen("tcp", a.Addr)
	if err != nil {
		return err
	}
	a.Log.Info("activator listening", "addr", ln.Addr().String())
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (a *Activator) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *Activator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")

	app, err := a.lookup(r.Context(), host)
	if err != nil {
		a.Log.Error(err, "activator lookup failed", "host", host)
		a.page(w, r, http.StatusServiceUnavailable, pageData{Host: host, Title: "Try again shortly",
			Text: "The app could not be looked up just now.", Refresh: 10})
		return
	}
	if app == nil {
		a.page(w, r, http.StatusNotFound, pageData{Host: host, Title: "No app here",
			Text: "No app is served at this address."})
		return
	}
	if err := a.wake(r.Context(), app); err != nil {
		a.Log.Error(err, "waking app failed", "app", client.ObjectKeyFromObject(app).String())
	}
	data := pageData{Host: host, Title: "Starting the app",
		Text: "This app was idle and is starting. The page reloads by itself when the app is ready, usually within a minute.", Refresh: 5}
	if app.Status.Phase == appsv1alpha1.AppPhaseFailed {
		data.Title, data.Text, data.Refresh = "The app cannot start", "Ask its owner to check the app in the Apps UI.", 30
	}
	w.Header().Set("Retry-After", "5")
	a.page(w, r, http.StatusServiceUnavailable, data)
}

// lookup finds the App holding host's subdomain (nil if none).
func (a *Activator) lookup(ctx context.Context, host string) (*appsv1alpha1.App, error) {
	sub, ok := strings.CutSuffix(host, "."+strings.ToLower(a.AppsDomain))
	if !ok || sub == "" || strings.Contains(sub, ".") || len(sub) > 63 {
		return nil, nil
	}
	apps := &appsv1alpha1.AppList{}
	if err := a.Client.List(ctx, apps, client.MatchingLabels{SubdomainLabel: sub}); err != nil {
		return nil, err
	}
	var holder *appsv1alpha1.App
	for i := range apps.Items {
		app := &apps.Items[i]
		if app.DeletionTimestamp != nil || app.Spec.Access.Subdomain != sub {
			continue
		}
		if holder == nil || holdsBefore(app, holder) {
			holder = app
		}
	}
	return holder, nil
}

// wake stamps WakeAnnotation, at most once per wakeThrottle.
func (a *Activator) wake(ctx context.Context, app *appsv1alpha1.App) error {
	now := a.now()
	if t, ok := wakeRequested(app); ok && now.Sub(t) < wakeThrottle && !t.After(now) {
		return nil
	}
	patch := client.MergeFrom(app.DeepCopy())
	ann := app.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	ann[appsv1alpha1.WakeAnnotation] = now.UTC().Format(time.RFC3339)
	app.SetAnnotations(ann)
	return a.Client.Patch(ctx, app, patch)
}

type pageData struct {
	Host, Title, Text string
	Refresh           int
}

var activatorPage = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{{if .Refresh}}<meta http-equiv="refresh" content="{{.Refresh}}">{{end}}
<title>{{.Title}}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1d1d22; --muted: #5b5b66; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #ececf1; --muted: #a4a4b0; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 32rem; padding: 2rem 1rem; text-align: center; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { margin: .25rem 0; color: var(--muted); }
code { font-size: .9em; }
</style>
</head>
<body>
<main>
<h1>{{.Title}}</h1>
<p>{{.Text}}</p>
<p><code>{{.Host}}</code></p>
</main>
</body>
</html>
`))

func (a *Activator) page(w http.ResponseWriter, r *http.Request, status int, data pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	_ = activatorPage.Execute(w, data)
}
