package controller

import (
	"context"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func TestValidateGitURL(t *testing.T) {
	ok := []string{
		"https://github.com/example/site",
		"https://gitlab.example.org/group/repo.git",
	}
	bad := []string{
		"--upload-pack=touch /tmp/pwned",
		"-c core.sshCommand=x",
		"file:///etc",
		"http://github.com/example/site",
		"ssh://git@github.com/example/site",
		"git@github.com:example/site.git",
		"https://user:token@github.com/example/site",
		"https://token@github.com/example/site",
		"https://localhost/repo",
		"https://127.0.0.1/repo",
		"https://10.0.0.5/repo",
		"https://169.254.169.254/latest",
		"https://[::1]/repo",
		"https://kubernetes.default.svc/api",
		"https://gitea.gitea.svc.cluster.local/repo",
		"https://gitea/repo",
		"https:///repo",
	}
	for _, u := range ok {
		if err := validateGitURL(u); err != nil {
			t.Errorf("validateGitURL(%q) = %v, want ok", u, err)
		}
	}
	for _, u := range bad {
		if err := validateGitURL(u); err == nil {
			t.Errorf("validateGitURL(%q) = nil, want error", u)
		}
	}
}

func TestReconcileRejectsUnsafeGitSource(t *testing.T) {
	for _, src := range []appsv1alpha1.GitSource{
		{URL: "--upload-pack=touch /tmp/pwned"},
		{URL: "file:///etc"},
		{URL: "https://user:token@github.com/example/site"},
		{URL: "https://github.com/example/site", Ref: "--upload-pack=x"},
	} {
		app := inlineApp("team-a")
		app.Spec.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypeGit, Git: &src}
		r, c := newReconciler(t, managedNamespace("team-a"), app)
		reconcile(t, r, app)
		if got := getApp(t, c, "docs-site", "team-a"); got.Status.Phase != appsv1alpha1.AppPhaseFailed {
			t.Errorf("%+v: phase = %q, want Failed", src, got.Status.Phase)
		}
		deploy := &appsv1.Deployment{}
		if err := c.Get(context.Background(), types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err == nil {
			t.Errorf("%+v: Deployment created for an invalid git source", src)
		}
	}
}

// Both clone paths (static and pixi) must end option parsing before the URL.
func TestGitCloneUsesOptionSeparator(t *testing.T) {
	for _, app := range []*appsv1alpha1.App{inlineApp("team-a"), pixiApp("team-a")} {
		app.Spec.Source = appsv1alpha1.AppSource{
			Type: appsv1alpha1.SourceTypeGit,
			Git:  &appsv1alpha1.GitSource{URL: "https://github.com/example/site", Ref: "main"},
		}
		r, c := newReconciler(t, managedNamespace("team-a"), app)
		reconcile(t, r, app)
		deploy := &appsv1.Deployment{}
		if err := c.Get(context.Background(), types.NamespacedName{Name: "app-" + app.Name, Namespace: "team-a"}, deploy); err != nil {
			t.Fatalf("%s: Deployment not created: %v", app.Name, err)
		}
		script := strings.Join(deploy.Spec.Template.Spec.InitContainers[0].Command, " ")
		if !strings.Contains(script, `-- "$GIT_URL"`) {
			t.Errorf("%s: clone command lacks the -- separator: %s", app.Name, script)
		}
	}
}
