package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

const (
	activatorSvc = "nebari-apps-activator"
	activatorNS  = "nebari-apps"
)

// fakePodActivity is a sidecar's /activity endpoint the test controls.
type fakePodActivity struct {
	srv  *httptest.Server
	last atomic.Int64
	fail atomic.Bool
	hits atomic.Int32
}

func newFakePodActivity(t *testing.T) *fakePodActivity {
	t.Helper()
	f := &fakePodActivity{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if f.fail.Load() || r.URL.Path != "/activity" {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_, _ = fmt.Fprintf(w, `{"lastRequest": %d, "inFlight": 0}`, f.last.Load())
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// idleReconciler is newReconciler with idling on: a cluster default of 30
// minutes, a fake clock and pod activity served by f.
func idleReconciler(t *testing.T, f *fakePodActivity, objs ...client.Object) (*AppReconciler, client.Client, *time.Time) {
	t.Helper()
	r, c := newReconciler(t, objs...)
	r.Config.IdleTimeout = 30 * time.Minute
	r.Config.ActivatorService = activatorSvc
	r.Config.ActivatorNamespace = activatorNS
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return now }
	r.ActivityURL = func(string) string { return f.srv.URL + "/activity" }
	return r, c, &now
}

func reconcileResult(t *testing.T, r *AppReconciler, app *appsv1alpha1.App) ctrl.Result {
	t.Helper()
	res, err := r.Reconcile(log.IntoContext(context.Background(), log.Log), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: app.Name, Namespace: app.Namespace},
	})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	return res
}

// readyPod is what the Deployment's ready replica looks like to the poller.
func readyPod(t *testing.T, c client.Client, app *appsv1alpha1.App) {
	t.Helper()
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: childName(app) + "-abc", Namespace: app.Namespace, Labels: appLabels(app)},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	if err := c.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	pod.Status = corev1.PodStatus{
		PodIP:      "10.0.0.7",
		Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
	}
	if err := c.Status().Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
}

func deletePods(t *testing.T, c client.Client, app *appsv1alpha1.App) {
	t.Helper()
	if err := c.DeleteAllOf(context.Background(), &corev1.Pod{}, client.InNamespace(app.Namespace),
		client.MatchingLabels(selectorLabels(app))); err != nil {
		t.Fatal(err)
	}
}

func nebariService(t *testing.T, c client.Client, app *appsv1alpha1.App) map[string]any {
	t.Helper()
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, na); err != nil {
		t.Fatal(err)
	}
	svc, _, _ := unstructured.NestedMap(na.Object, "spec", "service")
	return svc
}

func deploymentReplicas(t *testing.T, c client.Client, app *appsv1alpha1.App) int32 {
	t.Helper()
	d := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, d); err != nil {
		t.Fatal(err)
	}
	return *d.Spec.Replicas
}

func TestIdleTimeoutPolicy(t *testing.T) {
	on := OperatorConfig{AuthzImage: testAuthzImage, ActivatorService: activatorSvc, ActivatorNamespace: activatorNS,
		IdleTimeout: 30 * time.Minute}
	app := inlineApp("team-a")
	if got := on.idleTimeout(app); got != 30*time.Minute {
		t.Errorf("cluster default: %v", got)
	}
	app.Spec.Runtime.IdleTimeoutMinutes = ptr.To(int32(10))
	if got := on.idleTimeout(app); got != 10*time.Minute {
		t.Errorf("per-App override: %v", got)
	}
	app.Spec.Runtime.KeepAlive = true
	if got := on.idleTimeout(app); got != 0 {
		t.Errorf("keepAlive must exempt the App: %v", got)
	}

	off := on
	off.IdleTimeout = 0
	plain := inlineApp("team-a")
	if got := off.idleTimeout(plain); got != 0 {
		t.Errorf("no cluster default and no override: %v", got)
	}
	plain.Spec.Runtime.IdleTimeoutMinutes = ptr.To(int32(15))
	if got := off.idleTimeout(plain); got != 15*time.Minute {
		t.Errorf("an App can opt in without a cluster default: %v", got)
	}
	noActivator := on
	noActivator.ActivatorService = ""
	if got := noActivator.idleTimeout(plain); got != 0 || noActivator.hasSidecar(plain) {
		t.Errorf("idling needs the activator: %v", got)
	}
}

func TestIdleAppGetsPassthroughSidecar(t *testing.T) {
	f := newFakePodActivity(t)
	app := pixiApp("team-a")
	app.Spec.Access.Public = true
	r, c, _ := idleReconciler(t, f, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	d := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: "team-a"}, d); err != nil {
		t.Fatal(err)
	}
	pod := d.Spec.Template.Spec
	if len(pod.Containers) != 2 || pod.Containers[0].Name != "app" || pod.Containers[1].Name != "authz" {
		t.Fatalf("containers = %v, want app then authz", names(pod.Containers))
	}
	env := map[string]string{}
	for _, e := range pod.Containers[1].Env {
		env[e.Name] = e.Value
	}
	if env["AUTHZ_ISSUERS"] != "" || env["AUTHZ_GROUPS"] != "" || len(env) != 3 {
		t.Errorf("the sidecar must be passthrough only: %v", env)
	}
	for _, e := range pod.Containers[0].Env {
		if e.Name == "PORT" && e.Value != fmt.Sprint(AppInternalPort) {
			t.Errorf("PORT = %s, want %d behind the sidecar", e.Value, AppInternalPort)
		}
	}

	// keepAlive drops the sidecar again.
	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) { s.Runtime.KeepAlive = true })
	reconcile(t, r, app)
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: "team-a"}, d); err != nil {
		t.Fatal(err)
	}
	if len(d.Spec.Template.Spec.Containers) != 1 {
		t.Errorf("keepAlive App containers = %v, want app only", names(d.Spec.Template.Spec.Containers))
	}
	if got := getApp(t, c, app.Name, app.Namespace); got.Status.LastActivityTime != nil {
		t.Error("a keepAlive App should not track activity")
	}
}

func TestStaticIdleAppListensOnLoopback(t *testing.T) {
	f := newFakePodActivity(t)
	app := inlineApp("team-a")
	r, c, _ := idleReconciler(t, f, managedNamespace("team-a"), app)
	reconcile(t, r, app)
	cm := &corev1.ConfigMap{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app) + "-server", Namespace: "team-a"}, cm); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cm.Data["default.conf"], fmt.Sprintf("listen 127.0.0.1:%d;", AppInternalPort)) {
		t.Errorf("nginx should listen behind the sidecar:\n%s", cm.Data["default.conf"])
	}
}

// The whole cycle: Deploying (routed to the activator) → Running → Idle →
// a request to the activator → waking → Running.
func TestIdleCycle(t *testing.T) {
	f := newFakePodActivity(t)
	app := inlineApp("team-a")
	r, c, now := idleReconciler(t, f, managedNamespace("team-a"), app)
	ctx := context.Background()

	res := reconcileResult(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	if got.Status.LastActivityTime == nil || !got.Status.LastActivityTime.Time.Equal(*now) {
		t.Fatalf("a new idling App starts its clock now: %v", got.Status.LastActivityTime)
	}
	if res.RequeueAfter <= 0 || res.RequeueAfter > maxIdlePoll {
		t.Errorf("RequeueAfter = %v, want a poll within %v", res.RequeueAfter, maxIdlePoll)
	}
	if svc := nebariService(t, c, app); svc["name"] != activatorSvc || svc["namespace"] != activatorNS {
		t.Errorf("no pod is ready yet, so the NebariApp should route to the activator: %v", svc)
	}
	grant := &unstructured.Unstructured{}
	grant.SetGroupVersionKind(ReferenceGrantGVK)
	if err := c.Get(ctx, types.NamespacedName{Name: activatorSvc, Namespace: activatorNS}, grant); err != nil {
		t.Fatalf("ReferenceGrant: %v", err)
	}
	from, _, _ := unstructured.NestedSlice(grant.Object, "spec", "from")
	if len(from) != 1 || from[0].(map[string]any)["namespace"] != "team-a" {
		t.Errorf("ReferenceGrant from = %v", from)
	}

	// A pod is ready and serving.
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	setRoutingReady(t, c, app, true)
	readyPod(t, c, app)
	*now = now.Add(10 * time.Minute)
	f.last.Store(now.Unix())
	reconcile(t, r, app)
	got = wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
	if svc := nebariService(t, c, app); svc["name"] != childName(app) || svc["namespace"] != nil {
		t.Errorf("a ready App routes to its own Service: %v", svc)
	}
	if !got.Status.LastActivityTime.Time.Equal(*now) {
		t.Errorf("lastActivityTime = %v, want the pod's answer %v", got.Status.LastActivityTime, *now)
	}

	// 29 minutes later the last request is still within the timeout.
	*now = now.Add(29 * time.Minute)
	res = reconcileResult(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
	if res.RequeueAfter > 2*time.Minute {
		t.Errorf("RequeueAfter = %v, want the check due when the timeout runs out", res.RequeueAfter)
	}

	// 30 minutes without a request: Idle.
	*now = now.Add(time.Minute)
	reconcile(t, r, app)
	got = wantPhase(t, c, app, appsv1alpha1.AppPhaseIdle)
	if deploymentReplicas(t, c, app) != 0 {
		t.Error("an idle App's Deployment should be scaled to zero")
	}
	if svc := nebariService(t, c, app); svc["name"] != activatorSvc {
		t.Errorf("an idle App routes to the activator: %v", svc)
	}
	if !strings.Contains(got.Status.Message, "30 minutes") {
		t.Errorf("message = %q", got.Status.Message)
	}
	setDeployment(t, c, app, deployStatus{})
	deletePods(t, c, app)
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseIdle)

	// A visitor hits the activator.
	*now = now.Add(2 * time.Hour)
	act := &Activator{Client: c, AppsDomain: testDomain, Log: log.Log, Now: func() time.Time { return *now }}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/some/page?q=1", nil)
	req.Host = "docs-site." + testDomain + ":443"
	act.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "Starting the app") ||
		!strings.Contains(rec.Body.String(), `http-equiv="refresh"`) || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("activator: %d %s", rec.Code, rec.Body)
	}
	got = getApp(t, c, app.Name, app.Namespace)
	if got.Annotations[appsv1alpha1.WakeAnnotation] != now.Format(time.RFC3339) {
		t.Fatalf("wake annotation = %q", got.Annotations[appsv1alpha1.WakeAnnotation])
	}

	reconcile(t, r, app)
	got = wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	if !strings.Contains(got.Status.Message, "waking") {
		t.Errorf("message = %q", got.Status.Message)
	}
	if deploymentReplicas(t, c, app) != 1 {
		t.Error("a woken App should scale back to its replicas")
	}
	if svc := nebariService(t, c, app); svc["name"] != activatorSvc {
		t.Errorf("a waking App keeps routing to the activator until a pod is ready: %v", svc)
	}

	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	readyPod(t, c, app)
	*now = now.Add(30 * time.Second)
	f.last.Store(now.Add(-10 * time.Second).Unix()) // the sidecar's start
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
	if svc := nebariService(t, c, app); svc["name"] != childName(app) {
		t.Errorf("routing should move back to the App: %v", svc)
	}
}

// A failed check keeps the App up without pretending it saw a request:
// lastActivityTime stays as it was, the check runs again a poll interval
// later, and once the pod answers again the App idles on its real activity.
func TestIdleCheckFailureHoldsTheApp(t *testing.T) {
	f := newFakePodActivity(t)
	app := inlineApp("team-a")
	app.Spec.Runtime.IdleTimeoutMinutes = ptr.To(int32(5))
	r, c, now := idleReconciler(t, f, managedNamespace("team-a"), app)
	reconcile(t, r, app)
	start := *now
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	setRoutingReady(t, c, app, true)
	readyPod(t, c, app)
	f.fail.Store(true)

	*now = now.Add(time.Hour)
	res := reconcileResult(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
	if f.hits.Load() == 0 {
		t.Fatal("the pod was never asked")
	}
	if deploymentReplicas(t, c, app) != 1 {
		t.Error("a failed check must not idle the App")
	}
	if !got.Status.LastActivityTime.Time.Equal(start) {
		t.Errorf("a failed check is not a request: lastActivityTime = %v, want %v", got.Status.LastActivityTime, start)
	}
	if want := 5 * time.Minute / 6; res.RequeueAfter != want {
		t.Errorf("RequeueAfter = %v, want the poll interval %v", res.RequeueAfter, want)
	}

	// The pod answers again: its last request was long ago, so the App idles.
	f.fail.Store(false)
	f.last.Store(start.Unix())
	*now = now.Add(res.RequeueAfter)
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseIdle)
	if deploymentReplicas(t, c, app) != 0 {
		t.Error("the App should idle once the check works again")
	}
}

func TestFutureActivityClampsToNow(t *testing.T) {
	f := newFakePodActivity(t)
	app := inlineApp("team-a")
	r, c, now := idleReconciler(t, f, managedNamespace("team-a"), app)
	reconcile(t, r, app)
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	readyPod(t, c, app)
	f.last.Store(now.Add(24 * time.Hour).Unix())
	*now = now.Add(time.Minute)
	reconcile(t, r, app)
	if got := getApp(t, c, app.Name, app.Namespace); !got.Status.LastActivityTime.Time.Equal(*now) {
		t.Errorf("future activity should clamp to now: %v", got.Status.LastActivityTime)
	}
}

// terminatingPod marks the App's pod as being deleted, still Ready, as it is
// for a moment after the Deployment is scaled to zero.
func terminatingPod(t *testing.T, c client.Client, app *appsv1alpha1.App) {
	t.Helper()
	ctx := context.Background()
	pod := &corev1.Pod{}
	if err := c.Get(ctx, types.NamespacedName{Name: childName(app) + "-abc", Namespace: app.Namespace}, pod); err != nil {
		t.Fatal(err)
	}
	pod.Finalizers = []string{"test.nebari.dev/hold"}
	if err := c.Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
}

// Right after the scale-down the Deployment still reports its ready replica
// and the pod is terminating: the next reconcile (triggered by that very
// scale-down) must not read "no ready pod" as activity and scale back up.
func TestIdleAppStaysIdleWhileItsPodsTerminate(t *testing.T) {
	for _, phaseRecorded := range []bool{true, false} {
		t.Run(fmt.Sprintf("phaseRecorded=%v", phaseRecorded), func(t *testing.T) {
			f := newFakePodActivity(t)
			app := inlineApp("team-a")
			app.Spec.Runtime.IdleTimeoutMinutes = ptr.To(int32(5))
			r, c, now := idleReconciler(t, f, managedNamespace("team-a"), app)
			reconcile(t, r, app)
			setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
			setRoutingReady(t, c, app, true)
			readyPod(t, c, app)
			f.last.Store(now.Unix())

			*now = now.Add(5*time.Minute + time.Second)
			reconcile(t, r, app)
			got := wantPhase(t, c, app, appsv1alpha1.AppPhaseIdle)
			idleSince := got.Status.LastActivityTime.Time
			if deploymentReplicas(t, c, app) != 0 {
				t.Fatal("the App should have idled")
			}
			if !phaseRecorded {
				// The idling reconcile scaled the Deployment but failed before
				// it recorded the phase (a conflict on the NebariApp).
				got.Status.Phase = appsv1alpha1.AppPhaseRunning
				if err := c.Status().Update(context.Background(), got); err != nil {
					t.Fatal(err)
				}
			}

			terminatingPod(t, c, app)
			f.fail.Store(true) // a terminating pod's sidecar is gone
			hits := f.hits.Load()
			*now = now.Add(time.Second)
			res := reconcileResult(t, r, app)
			got = wantPhase(t, c, app, appsv1alpha1.AppPhaseIdle)
			if deploymentReplicas(t, c, app) != 0 {
				t.Error("the App was scaled back up while its pod terminated")
			}
			if !got.Status.LastActivityTime.Time.Equal(idleSince) {
				t.Errorf("lastActivityTime = %v, want it left at %v", got.Status.LastActivityTime, idleSince)
			}
			if f.hits.Load() != hits {
				t.Error("an idle App's terminating pods should not be asked")
			}
			if res.RequeueAfter != 0 {
				t.Errorf("an idle App waits for a request, not a poll: RequeueAfter = %v", res.RequeueAfter)
			}

			// A request still wakes it.
			got.Annotations = map[string]string{appsv1alpha1.WakeAnnotation: now.Format(time.RFC3339)}
			if err := c.Update(context.Background(), got); err != nil {
				t.Fatal(err)
			}
			reconcile(t, r, app)
			if deploymentReplicas(t, c, app) != 1 {
				t.Error("a woken App should scale back up")
			}
		})
	}
}

func TestStoppedAndKeepAliveAppsNeverIdle(t *testing.T) {
	f := newFakePodActivity(t)
	stopped := inlineApp("team-a")
	stopped.Spec.Runtime.Replicas = ptr.To(int32(0))
	keep := inlineApp("team-a")
	keep.Name, keep.Spec.Access.Subdomain = "keep", "keep"
	keep.Spec.Runtime.KeepAlive = true
	r, c, now := idleReconciler(t, f, managedNamespace("team-a"), stopped, keep)

	reconcile(t, r, stopped)
	reconcile(t, r, keep)
	*now = now.Add(48 * time.Hour)
	if res := reconcileResult(t, r, keep); res.RequeueAfter != 0 {
		t.Errorf("a keepAlive App needs no idle polling: %v", res.RequeueAfter)
	}
	reconcile(t, r, stopped)
	wantPhase(t, c, stopped, appsv1alpha1.AppPhaseStopped)
	got := wantPhase(t, c, keep, appsv1alpha1.AppPhaseDeploying)
	if got.Status.LastActivityTime != nil || deploymentReplicas(t, c, keep) != 1 {
		t.Error("a keepAlive App must not idle")
	}
	if svc := nebariService(t, c, keep); svc["name"] != childName(keep) {
		t.Errorf("a keepAlive App never routes to the activator: %v", svc)
	}
}

func TestReferenceGrantGainsNamespaces(t *testing.T) {
	f := newFakePodActivity(t)
	a := inlineApp("team-a")
	b := inlineApp("team-b")
	b.Spec.Access.Subdomain = "other"
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: activatorSvc, Namespace: activatorNS, UID: "svc-uid"}}
	r, c, _ := idleReconciler(t, f, managedNamespace("team-a"), managedNamespace("team-b"), a, b, svc)
	reconcile(t, r, a)
	reconcile(t, r, b)
	reconcile(t, r, a)

	grant := &unstructured.Unstructured{}
	grant.SetGroupVersionKind(ReferenceGrantGVK)
	if err := c.Get(context.Background(), types.NamespacedName{Name: activatorSvc, Namespace: activatorNS}, grant); err != nil {
		t.Fatal(err)
	}
	from, _, _ := unstructured.NestedSlice(grant.Object, "spec", "from")
	if len(from) != 2 {
		t.Fatalf("from = %v, want team-a and team-b once each", from)
	}
	to, _, _ := unstructured.NestedSlice(grant.Object, "spec", "to")
	if len(to) != 1 || to[0].(map[string]any)["name"] != activatorSvc {
		t.Errorf("to = %v", to)
	}
	if refs := grant.GetOwnerReferences(); len(refs) != 1 || refs[0].UID != "svc-uid" {
		t.Errorf("the grant should be owned by the activator Service: %v", refs)
	}
}

func TestActivator(t *testing.T) {
	app := inlineApp("team-a")
	failed := inlineApp("team-b")
	failed.Name, failed.Spec.Access.Subdomain = "broken", "broken"
	failed.Status.Phase = appsv1alpha1.AppPhaseFailed
	for _, a := range []*appsv1alpha1.App{app, failed} {
		a.Labels = map[string]string{SubdomainLabel: a.Spec.Access.Subdomain}
	}
	_, c := newReconciler(t, app, failed)
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	act := &Activator{Client: c, AppsDomain: testDomain, Log: log.Log, Now: func() time.Time { return now }}

	serve := func(method, host string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/", nil)
		req.Host = host
		act.ServeHTTP(rec, req)
		return rec
	}

	for _, host := range []string{"nope." + testDomain, "docs-site.example.com", testDomain, "a.b." + testDomain} {
		if rec := serve(http.MethodGet, host); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d", host, rec.Code)
		}
	}

	rec := serve(http.MethodHead, "Docs-Site."+testDomain+".")
	if rec.Code != http.StatusServiceUnavailable || rec.Body.Len() != 0 {
		t.Errorf("HEAD: %d %q", rec.Code, rec.Body)
	}
	first := getApp(t, c, app.Name, app.Namespace).Annotations[appsv1alpha1.WakeAnnotation]
	if first != now.Format(time.RFC3339) {
		t.Fatalf("wake annotation = %q", first)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
		t.Errorf("CSP = %q", csp)
	}

	// Reloads within the throttle do not patch again.
	now = now.Add(5 * time.Second)
	serve(http.MethodGet, "docs-site."+testDomain)
	if got := getApp(t, c, app.Name, app.Namespace).Annotations[appsv1alpha1.WakeAnnotation]; got != first {
		t.Errorf("re-stamped within the throttle: %q", got)
	}
	now = now.Add(wakeThrottle)
	serve(http.MethodGet, "docs-site."+testDomain)
	if got := getApp(t, c, app.Name, app.Namespace).Annotations[appsv1alpha1.WakeAnnotation]; got == first {
		t.Error("not re-stamped after the throttle")
	}

	if rec := serve(http.MethodGet, "broken."+testDomain); !strings.Contains(rec.Body.String(), "cannot start") {
		t.Errorf("a Failed App: %s", rec.Body)
	}
	if act.NeedLeaderElection() {
		t.Error("the activator must run on every replica")
	}
}

func TestActivatorStart(t *testing.T) {
	_, c := newReconciler(t)
	act := &Activator{Client: c, AppsDomain: testDomain, Addr: "127.0.0.1:0", Log: log.Log}
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- act.Start(ctx) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-errc; err != nil {
		t.Fatalf("Start: %v", err)
	}
}

func TestFetchActivityRejectsBadAnswers(t *testing.T) {
	bodies := map[string]string{"not json": "nope", "no time": `{"inFlight":0}`}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()
			r := &AppReconciler{ActivityURL: func(string) string { return srv.URL }, HTTPClient: NewActivityClient()}
			if _, err := r.fetchActivity(context.Background(), "10.0.0.1"); err == nil {
				t.Error("want an error")
			}
		})
	}
}
