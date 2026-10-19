package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// Source handling shared by the static and pixi pod specs: each source type
// becomes a content volume (inline, pvc) or an init container that fills one
// (git). The pod builders decide where the content is mounted.

// inlineConfigMapData maps inline file paths onto valid ConfigMap keys.
// ConfigMap keys cannot contain '/', so files are stored under generated
// keys and mapped back to their real (possibly nested) paths via volume
// items when mounted.
func inlineConfigMapData(files map[string]string) (map[string]string, []corev1.KeyToPath) {
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	data := make(map[string]string, len(files))
	items := make([]corev1.KeyToPath, 0, len(files))
	for i, p := range paths {
		key := fmt.Sprintf("f%04d", i)
		data[key] = files[p]
		items = append(items, corev1.KeyToPath{Key: key, Path: p})
	}
	return data, items
}

// buildContentConfigMap renders inline source files into a ConfigMap that is
// mounted as the app source root. Returns nil for non-inline sources.
func buildContentConfigMap(app *appsv1alpha1.App) *corev1.ConfigMap {
	if app.Spec.Source.Type != appsv1alpha1.SourceTypeInline || app.Spec.Source.Inline == nil {
		return nil
	}
	data, _ := inlineConfigMapData(app.Spec.Source.Inline.Files)
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      childName(app) + "-content",
			Namespace: app.Namespace,
			Labels:    appLabels(app),
		},
		Data: data,
	}
}

// contentChecksum produces a stable hash of inline content so the pod
// template rolls when the files change.
func contentChecksum(files map[string]string) string {
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		h.Write([]byte(k))
		h.Write([]byte{0})
		h.Write([]byte(files[k]))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// inlineContentVolume mounts the content ConfigMap with items mapping the
// generated keys back onto their real file paths.
func inlineContentVolume(app *appsv1alpha1.App) corev1.Volume {
	_, items := inlineConfigMapData(app.Spec.Source.Inline.Files)
	return corev1.Volume{
		Name: contentVolume,
		VolumeSource: corev1.VolumeSource{
			ConfigMap: &corev1.ConfigMapVolumeSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: childName(app) + "-content"},
				Items:                items,
			},
		},
	}
}

// pvcContentVolume mounts an App's claim read-only as the content volume
// (checkMountable has already required the claim's opt-in label).
func pvcContentVolume(pvc *appsv1alpha1.PVCSource) corev1.Volume {
	return corev1.Volume{
		Name: contentVolume,
		VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
				ClaimName: pvc.ClaimName,
				ReadOnly:  true,
			},
		},
	}
}

// gitCloneInit clones a git source and copies its subdir into the volume at
// dest.MountPath. Values are passed via env so the script never interpolates
// user-controlled strings. The clone lands in /tmp because the container runs
// as a non-root user that cannot write /.
func (r *AppReconciler) gitCloneInit(git *appsv1alpha1.GitSource, dest corev1.VolumeMount,
	security *corev1.SecurityContext) corev1.Container {
	ref := git.Ref
	if ref == "" {
		ref = "main"
	}
	return corev1.Container{
		Name:  "git-clone",
		Image: r.Config.GitImage,
		Command: []string{"sh", "-c",
			gitCloneScript + fmt.Sprintf(`cp -r "/tmp/clone/$GIT_SUBDIR/." %s/`, dest.MountPath),
		},
		Env: []corev1.EnvVar{
			{Name: "GIT_URL", Value: git.URL},
			{Name: "GIT_REF", Value: ref},
			{Name: "GIT_SUBDIR", Value: sanitizeSubdir(git.Subdir)},
			{Name: "HOME", Value: "/tmp"},
		},
		SecurityContext: security,
		VolumeMounts:    []corev1.VolumeMount{dest},
	}
}

// gitCloneScript clones GIT_URL at GIT_REF into /tmp/clone. User values
// arrive only through env vars, and `--` ends option parsing so a URL can
// never be read as a git option (validate() also rejects anything but https).
const gitCloneScript = `git clone --depth 1 --branch "$GIT_REF" -- "$GIT_URL" /tmp/clone && `

// sanitizeSubdir normalizes a git subdir so it stays inside the clone.
func sanitizeSubdir(subdir string) string {
	if subdir == "" || subdir == "." {
		return "."
	}
	return subdir
}
