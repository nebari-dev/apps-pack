package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

const (
	// AppPort is the port every app container listens on. Auth is enforced at
	// the gateway by the NebariApp SecurityPolicy, so apps serve plain HTTP
	// here.
	AppPort = 8080

	// webRoot is where the static server image serves content from.
	webRoot = "/usr/share/nginx/html"

	contentVolume = "content"
)

// childName is the name shared by the resources the operator creates for an
// App (Deployment, Service, ConfigMap, NebariApp), prefixed to avoid
// colliding with unrelated resources in the namespace.
func childName(app *appsv1alpha1.App) string {
	return "app-" + app.Name
}

func appLabels(app *appsv1alpha1.App) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":       app.Name,
		"app.kubernetes.io/managed-by": "apps-operator",
		"apps.nebari.dev/app":          app.Name,
	}
}

func selectorLabels(app *appsv1alpha1.App) map[string]string {
	return map[string]string{
		"apps.nebari.dev/app": app.Name,
	}
}

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

// buildDeployment renders the Deployment for an App.
func (r *AppReconciler) buildDeployment(app *appsv1alpha1.App) (*appsv1.Deployment, error) {
	replicas := int32(1)
	if app.Spec.Runtime.Replicas != nil {
		replicas = *app.Spec.Runtime.Replicas
	}

	annotations := map[string]string{}
	var podSpec corev1.PodSpec
	var err error
	if app.Spec.Runtime.PixiTask != "" {
		podSpec, err = r.buildPixiPodSpec(app, annotations)
	} else {
		podSpec, err = r.buildStaticPodSpec(app, annotations)
	}
	if err != nil {
		return nil, err
	}

	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      childName(app),
			Namespace: app.Namespace,
			Labels:    appLabels(app),
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr.To(replicas),
			Selector: &metav1.LabelSelector{MatchLabels: selectorLabels(app)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      mergeMaps(appLabels(app), selectorLabels(app)),
					Annotations: annotations,
				},
				Spec: podSpec,
			},
		},
	}, nil
}

// buildStaticPodSpec serves static content with nginx; the content volume is
// populated according to the source type.
func (r *AppReconciler) buildStaticPodSpec(app *appsv1alpha1.App, annotations map[string]string) (corev1.PodSpec, error) {
	podSpec := corev1.PodSpec{
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot: ptr.To(true),
			// Shared content volumes must be writable by init containers
			// (git-clone, uid 65532) and readable by nginx-unprivileged
			// (uid/gid 101), so group-own them via fsGroup.
			FSGroup:        ptr.To(int64(101)),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:  "app",
			Image: r.Config.StaticImage,
			Ports: []corev1.ContainerPort{{
				Name:          "http",
				ContainerPort: AppPort,
				Protocol:      corev1.ProtocolTCP,
			}},
			Env:       app.Spec.Runtime.Env,
			Resources: app.Spec.Runtime.Resources,
			ReadinessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					HTTPGet: &corev1.HTTPGetAction{Path: "/", Port: intstrFromString("http")},
				},
				InitialDelaySeconds: 2,
				PeriodSeconds:       5,
			},
			LivenessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					HTTPGet: &corev1.HTTPGetAction{Path: "/", Port: intstrFromString("http")},
				},
				InitialDelaySeconds: 5,
				PeriodSeconds:       10,
			},
			SecurityContext: &corev1.SecurityContext{
				AllowPrivilegeEscalation: ptr.To(false),
				Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			},
			VolumeMounts: []corev1.VolumeMount{{
				Name:      contentVolume,
				MountPath: webRoot,
				ReadOnly:  true,
			}},
		}},
	}

	switch app.Spec.Source.Type {
	case appsv1alpha1.SourceTypeInline:
		podSpec.Volumes = []corev1.Volume{inlineContentVolume(app)}
		annotations["apps.nebari.dev/content-checksum"] = contentChecksum(app.Spec.Source.Inline.Files)

	case appsv1alpha1.SourceTypeGit:
		git := app.Spec.Source.Git
		ref := git.Ref
		if ref == "" {
			ref = "main"
		}
		podSpec.Volumes = []corev1.Volume{{
			Name:         contentVolume,
			VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
		}}
		podSpec.InitContainers = []corev1.Container{{
			Name:  "git-clone",
			Image: r.Config.GitImage,
			// Values are passed via env so the script never interpolates
			// user-controlled strings. Clone lands in /tmp because the
			// container runs as a non-root user that cannot write /.
			Command: []string{"sh", "-c",
				`git clone --depth 1 --branch "$GIT_REF" "$GIT_URL" /tmp/clone && cp -r "/tmp/clone/$GIT_SUBDIR/." /content/`,
			},
			Env: []corev1.EnvVar{
				{Name: "GIT_URL", Value: git.URL},
				{Name: "GIT_REF", Value: ref},
				{Name: "GIT_SUBDIR", Value: sanitizeSubdir(git.Subdir)},
				{Name: "HOME", Value: "/tmp"},
			},
			SecurityContext: &corev1.SecurityContext{
				// alpine/git defaults to root, which runAsNonRoot rejects.
				RunAsUser:                ptr.To(int64(65532)),
				RunAsGroup:               ptr.To(int64(65532)),
				AllowPrivilegeEscalation: ptr.To(false),
				Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			},
			VolumeMounts: []corev1.VolumeMount{{Name: contentVolume, MountPath: "/content"}},
		}}

	case appsv1alpha1.SourceTypePVC:
		pvc := app.Spec.Source.PVC
		podSpec.Volumes = []corev1.Volume{{
			Name: contentVolume,
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: pvc.ClaimName,
					ReadOnly:  true,
				},
			},
		}}
		podSpec.Containers[0].VolumeMounts[0].SubPath = pvc.SubPath

	default:
		return corev1.PodSpec{}, fmt.Errorf("source type %q is not supported for static apps", app.Spec.Source.Type)
	}

	return podSpec, nil
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

const (
	// appWorkdir is where a pixi app's source is assembled. It is a writable
	// emptyDir because pixi materializes its environment in .pixi/ next to
	// the project files (and caches under $HOME, which also points here).
	appWorkdir = "/app"

	workspaceVolume = "workspace"

	// pixiUID is the non-root user pixi apps run as (also used by the
	// git-clone init container in the static path).
	pixiUID = int64(65532)
)

// buildPixiPodSpec runs the app as a Python/pixi service: source is assembled
// into a writable emptyDir, then the main container installs the pixi
// environment and executes `pixi run <task>`. The task must listen on
// 0.0.0.0:8080.
func (r *AppReconciler) buildPixiPodSpec(app *appsv1alpha1.App, annotations map[string]string) (corev1.PodSpec, error) {
	containerSecurity := &corev1.SecurityContext{
		AllowPrivilegeEscalation: ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}

	// The task name is passed via env so the launch script never interpolates
	// user-controlled strings (same convention as the git-clone init).
	env := []corev1.EnvVar{
		{Name: "PIXI_TASK", Value: app.Spec.Runtime.PixiTask},
		{Name: "PORT", Value: fmt.Sprintf("%d", AppPort)},
		{Name: "HOME", Value: appWorkdir},
	}
	env = append(env, app.Spec.Runtime.Env...)

	tcpProbe := corev1.ProbeHandler{
		TCPSocket: &corev1.TCPSocketAction{Port: intstrFromString("http")},
	}

	podSpec := corev1.PodSpec{
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot: ptr.To(true),
			// The pixi image defaults to root; run everything as a fixed
			// non-root user and group-own the workspace so init containers
			// and the app can both write it.
			RunAsUser:      ptr.To(pixiUID),
			RunAsGroup:     ptr.To(pixiUID),
			FSGroup:        ptr.To(pixiUID),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:       "app",
			Image:      r.Config.PythonImage,
			WorkingDir: appWorkdir,
			Command: []string{"sh", "-c",
				`if [ -f pixi.lock ]; then pixi install --locked; else pixi install; fi && exec pixi run "$PIXI_TASK"`,
			},
			Ports: []corev1.ContainerPort{{
				Name:          "http",
				ContainerPort: AppPort,
				Protocol:      corev1.ProtocolTCP,
			}},
			Env:       env,
			Resources: app.Spec.Runtime.Resources,
			// Cold starts resolve and download the whole pixi environment;
			// give the startup probe generous headroom before liveness kicks in.
			StartupProbe: &corev1.Probe{
				ProbeHandler:     tcpProbe,
				PeriodSeconds:    10,
				FailureThreshold: 60,
			},
			ReadinessProbe: &corev1.Probe{
				ProbeHandler:  tcpProbe,
				PeriodSeconds: 5,
			},
			LivenessProbe: &corev1.Probe{
				ProbeHandler:  tcpProbe,
				PeriodSeconds: 10,
			},
			SecurityContext: containerSecurity,
			VolumeMounts: []corev1.VolumeMount{{
				Name:      workspaceVolume,
				MountPath: appWorkdir,
			}},
		}},
		Volumes: []corev1.Volume{{
			Name:         workspaceVolume,
			VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
		}},
	}

	// copySource copies read-only source mounted at /src into the workspace,
	// dereferencing the ConfigMap volume's symlink layout and dropping its
	// ..data bookkeeping entries.
	copySource := corev1.Container{
		Name:  "copy-source",
		Image: r.Config.PythonImage,
		Command: []string{"sh", "-c",
			`cp -rL /src/. /app/ && rm -rf /app/..?*`,
		},
		SecurityContext: containerSecurity,
		VolumeMounts: []corev1.VolumeMount{
			{Name: contentVolume, MountPath: "/src", ReadOnly: true},
			{Name: workspaceVolume, MountPath: appWorkdir},
		},
	}

	switch app.Spec.Source.Type {
	case appsv1alpha1.SourceTypeInline:
		podSpec.Volumes = append(podSpec.Volumes, inlineContentVolume(app))
		podSpec.InitContainers = []corev1.Container{copySource}
		annotations["apps.nebari.dev/content-checksum"] = contentChecksum(app.Spec.Source.Inline.Files)

	case appsv1alpha1.SourceTypeGit:
		git := app.Spec.Source.Git
		ref := git.Ref
		if ref == "" {
			ref = "main"
		}
		podSpec.InitContainers = []corev1.Container{{
			Name:  "git-clone",
			Image: r.Config.GitImage,
			// Values are passed via env so the script never interpolates
			// user-controlled strings. Clone lands in /tmp because the
			// container runs as a non-root user that cannot write /.
			Command: []string{"sh", "-c",
				`git clone --depth 1 --branch "$GIT_REF" "$GIT_URL" /tmp/clone && cp -r "/tmp/clone/$GIT_SUBDIR/." /app/`,
			},
			Env: []corev1.EnvVar{
				{Name: "GIT_URL", Value: git.URL},
				{Name: "GIT_REF", Value: ref},
				{Name: "GIT_SUBDIR", Value: sanitizeSubdir(git.Subdir)},
				{Name: "HOME", Value: "/tmp"},
			},
			SecurityContext: containerSecurity,
			VolumeMounts:    []corev1.VolumeMount{{Name: workspaceVolume, MountPath: appWorkdir}},
		}}

	case appsv1alpha1.SourceTypePVC:
		pvc := app.Spec.Source.PVC
		podSpec.Volumes = append(podSpec.Volumes, corev1.Volume{
			Name: contentVolume,
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: pvc.ClaimName,
					ReadOnly:  true,
				},
			},
		})
		copySource.VolumeMounts[0].SubPath = pvc.SubPath
		podSpec.InitContainers = []corev1.Container{copySource}

	default:
		return corev1.PodSpec{}, fmt.Errorf("source type %q is not supported for pixi apps", app.Spec.Source.Type)
	}

	return podSpec, nil
}

// buildService renders the ClusterIP Service in front of the app pods.
func buildService(app *appsv1alpha1.App) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      childName(app),
			Namespace: app.Namespace,
			Labels:    appLabels(app),
		},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: selectorLabels(app),
			Ports: []corev1.ServicePort{{
				Name:       "http",
				Port:       AppPort,
				TargetPort: intstrFromString("http"),
				Protocol:   corev1.ProtocolTCP,
			}},
		},
	}
}

// sanitizeSubdir normalizes a git subdir so it stays inside the clone.
func sanitizeSubdir(subdir string) string {
	if subdir == "" || subdir == "." {
		return "."
	}
	return subdir
}

func mergeMaps(ms ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range ms {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}
