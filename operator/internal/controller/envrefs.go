package controller

import (
	"errors"
	"fmt"
	"strings"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// ForbiddenEnvReference is the Validated condition reason (and event reason)
// for an App whose runtime.env reads data that belongs to another App.
const ForbiddenEnvReference = "ForbiddenEnvReference"

// errForbiddenEnvRef marks a validation error raised by checkEnvRefs.
type errForbiddenEnvRef struct{ msg string }

func (e errForbiddenEnvRef) Error() string { return e.msg }

func isForbiddenEnvRef(err error) bool {
	var f errForbiddenEnvRef
	return errors.As(err, &f)
}

// checkEnvRefs refuses runtime.env entries through which an App's pod would
// read another App's data. The kubelet resolves valueFrom with its own
// credentials, so whoever can write an App could otherwise read any Secret in
// the namespace by naming it, without being allowed to read Secrets at all:
//
//   - no secretKeyRef at all: credentials belong in runtime.secretKeys, which
//     reads only the App's own Secret (app-<name>-secrets). The CRD refuses
//     it too; this catches Apps stored before that rule.
//   - configMapKeyRef may not name a ConfigMap the operator generates for
//     another App (app-<other>-content: its inline source, app-<other>-server).
//
// fieldRef and resourceFieldRef only expose the pod's own metadata and
// resources, and fileKeyRef reads a volume of the pod itself, so they stay
// allowed.
func checkEnvRefs(app *appsv1alpha1.App) error {
	for _, e := range app.Spec.Runtime.Env {
		if e.ValueFrom == nil {
			continue
		}
		if ref := e.ValueFrom.SecretKeyRef; ref != nil {
			return errForbiddenEnvRef{fmt.Sprintf(
				"runtime.env %s: secretKeyRef (Secret %q) is not allowed; list the key in runtime.secretKeys, "+
					"which reads the app's own Secret %s", e.Name, ref.Name, appsv1alpha1.SecretName(app.Name))}
		}
		if ref := e.ValueFrom.ConfigMapKeyRef; ref != nil && isOtherAppsConfigMap(app, ref.Name) {
			return errForbiddenEnvRef{fmt.Sprintf(
				"runtime.env %s: configMapKeyRef may not name %q, a ConfigMap of another app", e.Name, ref.Name)}
		}
	}
	return nil
}

// isOtherAppsConfigMap reports whether name has the shape of a ConfigMap the
// operator creates for an App (app-<name>-content, app-<name>-server) other
// than this one.
func isOtherAppsConfigMap(app *appsv1alpha1.App, name string) bool {
	if !strings.HasPrefix(name, "app-") ||
		(!strings.HasSuffix(name, "-content") && !strings.HasSuffix(name, "-server")) {
		return false
	}
	return name != childName(app)+"-content" && name != childName(app)+"-server"
}
