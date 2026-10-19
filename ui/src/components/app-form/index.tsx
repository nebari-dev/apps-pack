import { useReducer } from "react";
import { Button } from "@/components/ui/button";
import type { App } from "@/lib/types";
import {
  AccessSection,
  BasicsSection,
  type FormContext,
  RuntimeSection,
  SourceSection,
} from "./sections";
import {
  buildPayload,
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
}

/**
 * Launch and edit form. State and the rules for it (validation, the payload
 * each mode submits) live in ./state; each card is a section in ./sections.
 */
export function AppForm({
  mode,
  namespaces,
  appsDomain,
  appsScheme,
  initial,
  submitting,
  onSubmit,
}: AppFormProps) {
  const isEdit = mode === "edit";
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(initial, isEdit));
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    dispatch({ type: "set", field, value } as Parameters<typeof dispatch>[0]);

  // Namespaces can arrive after the first render (from /capabilities).
  if (!isEdit && !state.namespace && namespaces.length > 0) set("namespace", namespaces[0]);

  // The first problem with the form, and the control it belongs to, so that
  // control can be marked invalid and point at the message.
  const validation = validate(state, isEdit);
  const validationError = validation?.message ?? "";
  const errorProps = (field: string) =>
    validation?.field === field
      ? { "aria-invalid": true as const, "aria-describedby": "form-error" }
      : {};

  const handleSubmit = () => {
    if (validationError) return;
    const payload = buildPayload(state, isEdit, initial);
    if (payload) onSubmit(payload);
  };

  const form: FormContext = {
    state,
    set,
    dispatch,
    errorProps,
    isEdit,
    initial,
    namespaces,
    appsDomain,
  };
  return (
    <div className="max-w-3xl space-y-6">
      <BasicsSection form={form} />
      <SourceSection form={form} />
      <RuntimeSection form={form} />
      <AccessSection form={form} />

      <div className="flex items-center justify-end gap-3">
        {validationError ? (
          <p id="form-error" role="alert" className="text-destructive-foreground text-sm">
            {validationError}
          </p>
        ) : null}
        <p className="mr-auto text-muted-foreground text-sm">
          {appsScheme}://{(isEdit ? initial?.access?.subdomain : state.subdomain) || "<subdomain>"}.
          {appsDomain}
        </p>
        <Button size="lg" disabled={!!validationError} loading={submitting} onClick={handleSubmit}>
          {isEdit ? "Save changes" : "Launch app"}
        </Button>
      </div>
    </div>
  );
}
