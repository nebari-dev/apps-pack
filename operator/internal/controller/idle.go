package controller

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// Scale to zero. An App that can idle (idleTimeout > 0) runs the apps-proxy
// sidecar, which records when the app last served a request (GET /activity
// on its health port). The operator polls it, keeps the answer in
// status.lastActivityTime, and once the App has gone a whole idle timeout
// without a request it scales the Deployment to zero (phase Idle) and points
// the NebariApp at the activator: a Service in the operator's namespace,
// served by the operator itself (activator.go), that answers every request
// with a "starting" page and stamps WakeAnnotation on the App. The next
// reconcile sees the fresh activity, scales the Deployment back up, and moves
// routing back to the App's Service once a pod is ready.

const (
	// minIdlePoll and maxIdlePoll bound how often a running App's activity
	// is polled (a sixth of its idle timeout in between).
	minIdlePoll = 30 * time.Second
	maxIdlePoll = 5 * time.Minute

	activityTimeout  = 3 * time.Second
	activityMaxBytes = 4 << 10
)

// ReferenceGrantGVK lets HTTPRoutes in App namespaces send traffic to the
// activator Service in the operator's namespace.
var ReferenceGrantGVK = schema.GroupVersionKind{
	Group:   "gateway.networking.k8s.io",
	Version: "v1beta1",
	Kind:    "ReferenceGrant",
}

// idlingAvailable reports whether this operator can scale Apps to zero: it
// needs the sidecar image (activity) and the activator Service (wake-up).
func (c OperatorConfig) idlingAvailable() bool {
	return c.ProxyImage != "" && c.ActivatorService != "" && c.ActivatorNamespace != ""
}

// idleTimeout is how long an App may go without a request before it is
// scaled to zero; 0 means never. runtime.keepAlive opts out, and
// runtime.idleTimeoutMinutes overrides the cluster default.
func (c OperatorConfig) idleTimeout(app *appsv1alpha1.App) time.Duration {
	rt := app.Spec.Runtime
	if !c.idlingAvailable() || rt.KeepAlive {
		return 0
	}
	if rt.IdleTimeoutMinutes != nil {
		return time.Duration(*rt.IdleTimeoutMinutes) * time.Minute
	}
	return c.IdleTimeout
}

func specReplicas(app *appsv1alpha1.App) int32 {
	if app.Spec.Runtime.Replicas != nil {
		return *app.Spec.Runtime.Replicas
	}
	return 1
}

// idleState is the outcome of the idle check for one reconcile.
type idleState struct {
	// timeout is the App's idle timeout; 0 when it never idles (keepAlive,
	// stopped, or idling unavailable), and then nothing below applies.
	timeout time.Duration
	// idle: the Deployment is scaled to zero.
	idle bool
	// viaActivator: the NebariApp routes to the activator, because the App
	// is idle or no pod is ready yet (waking), so visitors get the starting
	// page instead of the gateway's 503.
	viaActivator bool
	// waking: the App was Idle and is starting again.
	waking bool
	// requeue is when to check again.
	requeue time.Duration
}

func (r *AppReconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *AppReconciler) reader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

// evaluateIdle decides whether the App is idle, recording the activity it
// saw in status.lastActivityTime. A failed activity check never idles the
// App: it stays up, its recorded activity is left as it was, and the check
// runs again a poll interval later.
func (r *AppReconciler) evaluateIdle(ctx context.Context, app *appsv1alpha1.App) (idleState, error) {
	timeout := r.Config.idleTimeout(app)
	if timeout == 0 || specReplicas(app) == 0 {
		app.Status.LastActivityTime = nil
		return idleState{}, nil
	}
	now := r.now()

	// A newly idling App starts its clock now.
	last := now
	if t := app.Status.LastActivityTime; t != nil {
		last = t.Time
	}
	if t, ok := wakeRequested(app); ok && t.After(last) {
		last = t
	}

	ready := int32(0)
	scaledDown := false
	deploy := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, deploy)
	switch {
	case err == nil:
		ready = deploy.Status.ReadyReplicas
		scaledDown = deploy.Spec.Replicas != nil && *deploy.Spec.Replicas == 0
	case !apierrors.IsNotFound(err):
		return idleState{}, fmt.Errorf("reading Deployment: %w", err)
	}
	// Once idle, the App stays idle until a request wakes it (the wake
	// annotation, above). Its pods are going away, and the Deployment's ready
	// count lags the scale-down, so asking them would find no ready pod and,
	// counted as activity, scale the App straight back up.
	alreadyIdle := scaledDown || app.Status.Phase == appsv1alpha1.AppPhaseIdle
	checkFailed := false
	if ready > 0 && !alreadyIdle {
		seen, err := r.podActivity(ctx, app)
		switch {
		case err != nil:
			logf.FromContext(ctx).Info("idle check failed; not idling the app this time", "error", err.Error())
			checkFailed = true
		case seen.After(last):
			last = seen
		}
	}
	if last.After(now) {
		last = now
	}
	app.Status.LastActivityTime = &metav1.Time{Time: last.Truncate(time.Second)}

	st := idleState{timeout: timeout}
	st.idle = !checkFailed && now.Sub(last) >= timeout
	st.viaActivator = st.idle || ready == 0
	st.waking = !st.idle && ready == 0 && app.Status.Phase == appsv1alpha1.AppPhaseIdle
	if !st.idle {
		st.requeue = min(max(timeout/6, minIdlePoll), maxIdlePoll)
		// Check again as soon as the timeout runs out. After a failed check
		// it may already have (until <= 0), and the poll interval applies.
		if until := last.Add(timeout).Sub(now) + time.Second; until > 0 && until < st.requeue {
			st.requeue = until
		}
	}
	return st, nil
}

// wakeRequested reads WakeAnnotation.
func wakeRequested(app *appsv1alpha1.App) (time.Time, bool) {
	v, ok := app.Annotations[appsv1alpha1.WakeAnnotation]
	if !ok {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, v)
	return t, err == nil
}

// podActivity asks the sidecar of every ready pod when it last served a
// request and returns the latest answer. The pods run untrusted code, so the
// answer is bounded in size and time, and the caller clamps it to now.
func (r *AppReconciler) podActivity(ctx context.Context, app *appsv1alpha1.App) (time.Time, error) {
	pods := &corev1.PodList{}
	if err := r.reader().List(ctx, pods, client.InNamespace(app.Namespace),
		client.MatchingLabels(selectorLabels(app))); err != nil {
		return time.Time{}, fmt.Errorf("listing pods: %w", err)
	}
	var latest time.Time
	polled := 0
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.DeletionTimestamp != nil || pod.Status.PodIP == "" || !podReady(pod) {
			continue
		}
		t, err := r.fetchActivity(ctx, pod.Status.PodIP)
		if err != nil {
			return time.Time{}, fmt.Errorf("pod %s: %w", pod.Name, err)
		}
		if t.After(latest) {
			latest = t
		}
		polled++
	}
	if polled == 0 {
		return time.Time{}, errors.New("no ready pod to ask")
	}
	return latest, nil
}

func podReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func (r *AppReconciler) fetchActivity(ctx context.Context, podIP string) (time.Time, error) {
	url := "http://" + net.JoinHostPort(podIP, strconv.Itoa(proxyHealthPort)) + "/activity"
	if r.ActivityURL != nil {
		url = r.ActivityURL(podIP)
	}
	ctx, cancel := context.WithTimeout(ctx, activityTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return time.Time{}, err
	}
	hc := r.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return time.Time{}, fmt.Errorf("/activity: %s", resp.Status)
	}
	var body struct {
		LastRequest int64 `json:"lastRequest"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, activityMaxBytes)).Decode(&body); err != nil {
		return time.Time{}, fmt.Errorf("/activity: %w", err)
	}
	if body.LastRequest <= 0 {
		return time.Time{}, errors.New("/activity: no lastRequest")
	}
	return time.Unix(body.LastRequest, 0), nil
}

// routeToActivator points a NebariApp at the activator Service instead of
// the App's own (spec.service.namespace is part of the pinned contract).
func (c OperatorConfig) routeToActivator(na *unstructured.Unstructured) {
	_ = unstructured.SetNestedMap(na.Object, map[string]any{
		"name":      c.ActivatorService,
		"namespace": c.ActivatorNamespace,
		"port":      int64(ActivatorServicePort),
	}, "spec", "service")
}

// ActivatorServicePort is the activator Service's port (the chart's
// <release>-activator Service).
const ActivatorServicePort = 8080

// ensureReferenceGrant lets HTTPRoutes in ns reference the activator Service:
// a cross-namespace backendRef needs a ReferenceGrant in the target
// namespace. One grant lists every namespace an App has idled in; entries
// are never removed (they only allow routing to the activator). It is owned
// by the activator Service, so uninstalling the chart removes it.
func (r *AppReconciler) ensureReferenceGrant(ctx context.Context, ns string) error {
	from := map[string]any{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "namespace": ns}
	grant := &unstructured.Unstructured{}
	grant.SetGroupVersionKind(ReferenceGrantGVK)
	key := types.NamespacedName{Name: r.Config.ActivatorService, Namespace: r.Config.ActivatorNamespace}
	err := r.reader().Get(ctx, key, grant)
	if apierrors.IsNotFound(err) {
		grant = &unstructured.Unstructured{Object: map[string]any{
			"metadata": map[string]any{
				"name":      key.Name,
				"namespace": key.Namespace,
				"labels":    map[string]any{"app.kubernetes.io/managed-by": "apps-operator"},
			},
			"spec": map[string]any{
				"from": []any{from},
				"to":   []any{map[string]any{"group": "", "kind": "Service", "name": key.Name}},
			},
		}}
		grant.SetGroupVersionKind(ReferenceGrantGVK)
		svc := &corev1.Service{}
		if err := r.reader().Get(ctx, key, svc); err == nil {
			grant.SetOwnerReferences([]metav1.OwnerReference{{
				APIVersion: "v1", Kind: "Service", Name: svc.Name, UID: svc.UID,
			}})
		}
		return r.Create(ctx, grant)
	}
	if err != nil {
		return err
	}
	entries, _, _ := unstructured.NestedSlice(grant.Object, "spec", "from")
	for _, e := range entries {
		if m, ok := e.(map[string]any); ok && m["kind"] == "HTTPRoute" && m["namespace"] == ns {
			return nil
		}
	}
	if err := unstructured.SetNestedSlice(grant.Object, append(entries, from), "spec", "from"); err != nil {
		return err
	}
	return r.Update(ctx, grant)
}

// NewActivityClient is the HTTP client the operator polls app pods with:
// no proxy from the environment, no redirects, short timeouts.
func NewActivityClient() *http.Client {
	return &http.Client{
		Timeout: activityTimeout,
		Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: activityTimeout}).DialContext,
			MaxIdleConnsPerHost: 1,
			IdleConnTimeout:     30 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}
