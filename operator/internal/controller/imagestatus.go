package controller

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// maxKubeletMessage bounds the kubelet's message copied into the App's
// status (a registry error can be long).
const maxKubeletMessage = 300

// imagePodProblem explains why an image App's pods cannot start, when the
// kubelet says so: the image runs as root (or as a user name it cannot verify
// as non-root), which runAsNonRoot refuses, or the image cannot be pulled.
// It returns an empty reason otherwise (still starting, or crashing: the
// app's own logs tell that story).
func (r *AppReconciler) imagePodProblem(ctx context.Context, app *appsv1alpha1.App) (reason, message string) {
	pods := &corev1.PodList{}
	if err := r.reader().List(ctx, pods, client.InNamespace(app.Namespace),
		client.MatchingLabels(selectorLabels(app))); err != nil {
		return "", ""
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.DeletionTimestamp != nil {
			continue
		}
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Name != "app" || cs.State.Waiting == nil {
				continue
			}
			w := cs.State.Waiting
			detail := truncate(w.Message, maxKubeletMessage)
			switch {
			case w.Reason == "CreateContainerConfigError" && strings.Contains(w.Message, "runAsNonRoot"):
				return appsv1alpha1.ReasonImageRunsAsRoot, fmt.Sprintf(
					"the image runs as root or as a non-numeric user, and app pods must run as non-root: "+
						"rebuild it with a numeric non-root USER, or set source.image.runAsUser to a non-zero uid it works with (kubelet: %s)",
					detail)
			case w.Reason == "ErrImagePull" || w.Reason == "ImagePullBackOff" || w.Reason == "InvalidImageName":
				return appsv1alpha1.ReasonImagePullFailed, fmt.Sprintf(
					"the image cannot be pulled: check source.image.reference and, for a private registry, "+
						"the pull secret (chart apps.image.pullSecrets) (kubelet: %s)", detail)
			}
		}
	}
	return "", ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "..."
}
