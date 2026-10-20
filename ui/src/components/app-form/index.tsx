import { useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { App } from "@/lib/types";
import {
  AccessSection,
  BasicsSection,
  CONTROL_IDS,
  type FieldProps,
  type FormContext,
  RuntimeSection,
  SourceSection,
} from "./sections";
import {
  buildPayload,
  type Field,
  type FormState,
  initialState,
  reducer,
  type SubmitPayload,
  validate,
} from "./state";

export type { SubmitPayload } from "./state";

export interface AppFormProps {
  mode: "create" | "edit";
  namespaces: string[];
  appsDomain: string;
  appsScheme: string;
  initial?: App;
  submitting: boolean;
  onSubmit: (payload: SubmitPayload) => void;
  /** Leave the form without saving (the page decides where to go). */
  onCancel: () => void;
}

/**
 * Launch and edit form. State and the rules for it (validation, the payload
 * each mode submits) live in ./state; each card is a section in ./sections.
 *
 * Problems are computed on every render but only shown for a control once the
 * user has left it, or for every control after a submit attempt, so a fresh
 * form starts clean and the submit button stays enabled.
 */
export function AppForm({
  mode,
  namespaces,
  appsDomain,
  appsScheme,
  initial,
  submitting,
  onSubmit,
  onCancel,
}: AppFormProps) {
  const isEdit = mode === "edit";
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(initial, isEdit));
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    dispatch({ type: "set", field, value } as Parameters<typeof dispatch>[0]);

  // Namespaces can arrive after the first render (from /capabilities).
  if (!isEdit && !state.namespace && namespaces.length > 0) set("namespace", namespaces[0]);

  const problems = validate(state, isEdit);
  const shown = (field: Field) =>
    state.submitted || state.touched[field]
      ? problems.find((p) => p.field === field)?.message
      : undefined;

  const fieldProps = (field: Field, helpId?: string): FieldProps => {
    const message = shown(field);
    const describedBy = [helpId, message ? `${field}-error` : undefined].filter(Boolean).join(" ");
    return {
      ...(message ? { "aria-invalid": true as const } : {}),
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      onBlur: () => dispatch({ type: "touch", field }),
    };
  };

  // Announced once per submit attempt; the per-field messages stay silent so
  // they do not re-announce on every keystroke.
  const [announcement, setAnnouncement] = useState("");
  const focusFirstProblem = useRef(false);
  useEffect(() => {
    if (!focusFirstProblem.current) return;
    focusFirstProblem.current = false;
    const first = problems[0];
    if (first) document.getElementById(CONTROL_IDS[first.field])?.focus();
  });

  const handleSubmit = () => {
    if (problems.length > 0) {
      const n = problems.length;
      setAnnouncement(`${n} ${n === 1 ? "problem" : "problems"} to fix`);
      focusFirstProblem.current = true;
      dispatch({ type: "submit" });
      return;
    }
    setAnnouncement("");
    const payload = buildPayload(state, isEdit, initial);
    if (payload) onSubmit(payload);
  };

  const form: FormContext = {
    state,
    set,
    dispatch,
    fieldProps,
    errorFor: shown,
    isEdit,
    initial,
    namespaces,
    appsDomain,
  };
  const subdomain = isEdit ? initial?.access?.subdomain : state.subdomain;
  return (
    <div className="max-w-3xl space-y-6">
      <BasicsSection form={form} />
      <SourceSection form={form} />
      <RuntimeSection form={form} />
      <AccessSection form={form} />

      {/* Below sm the preview takes its own line and the buttons go full width. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <p
          data-testid="url-preview"
          className="min-w-0 break-all font-mono text-muted-foreground text-sm"
        >
          {appsScheme}://<span className="text-foreground">{subdomain || "<subdomain>"}</span>.
          {appsDomain}
        </p>
        <div className="flex flex-col gap-2 sm:ml-auto sm:flex-row">
          <Button variant="outline" className="w-full sm:w-auto" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" loading={submitting} onClick={handleSubmit}>
            {isEdit ? "Save changes" : "Launch app"}
          </Button>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
