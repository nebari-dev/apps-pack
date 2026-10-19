import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppForm, type SubmitPayload } from "@/components/app-form";
import type { App } from "@/lib/types";

function setup(
  props: Partial<Parameters<typeof AppForm>[0]> = {},
  userOptions: Parameters<typeof userEvent.setup>[0] = {},
) {
  const onSubmit = vi.fn<(p: SubmitPayload) => void>();
  const user = userEvent.setup(userOptions);
  render(
    <AppForm
      mode="create"
      namespaces={["apps", "team-a"]}
      appsDomain="apps.example.ai"
      appsScheme="https"
      submitting={false}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  const submit = () =>
    user.click(
      screen.getByRole("button", { name: props.mode === "edit" ? "Save changes" : "Launch app" }),
    );
  const error = () => screen.queryByRole("alert")?.textContent ?? "";
  return { user, onSubmit, submit, error };
}

const site = () => new File(["<h1>hi</h1>"], "site.zip", { type: "application/zip" });

describe("AppForm (create)", () => {
  it("walks the user through validation, one problem at a time", async () => {
    const { user, error } = setup();
    expect(error()).toBe("Give the app a name.");
    expect(screen.getByRole("button", { name: "Launch app" })).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "Sales");
    expect(error()).toBe("Name must be lowercase letters, digits, and hyphens.");

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "sales");
    // The subdomain follows the name until the user edits it.
    expect(screen.getByLabelText("Subdomain")).toHaveValue("sales");
    expect(error()).toBe("Give the app a display name.");

    await user.type(screen.getByLabelText("Display name"), "Sales");
    expect(error()).toBe("Choose a .zip or .html file to upload.");
    expect(screen.getByLabelText(/Drop a \.zip/)).toHaveAttribute("aria-invalid", "true");

    await user.upload(screen.getByLabelText(/Drop a \.zip/), site());
    expect(error()).toBe("");
    expect(screen.getByRole("button", { name: "Launch app" })).toBeEnabled();
  });

  it("rejects a subdomain that is not a DNS label", async () => {
    const { user, error } = setup();
    await user.type(screen.getByLabelText("Name"), "sales");
    await user.clear(screen.getByLabelText("Subdomain"));
    expect(error()).toBe("Pick a subdomain.");
    await user.type(screen.getByLabelText("Subdomain"), "-sales");
    expect(error()).toBe("Subdomain must be lowercase letters, digits, and hyphens.");
    expect(screen.getByLabelText("Subdomain")).toHaveAttribute("aria-describedby", "form-error");
  });

  it("submits an upload with the manifest and leaves the landing page to the cluster default", async () => {
    const { user, onSubmit, submit } = setup();
    await user.type(screen.getByLabelText("Name"), "sales");
    await user.type(screen.getByLabelText("Display name"), "Sales");
    await user.type(screen.getByLabelText("Description"), "Quarterly numbers");
    await user.type(screen.getByLabelText("Intended groups"), "analytics, finance ,");
    await user.upload(screen.getByLabelText(/Drop a \.zip/), site());
    await submit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    if (payload.kind !== "upload") throw new Error(`expected an upload, got ${payload.kind}`);
    expect(payload.file.name).toBe("site.zip");
    expect(payload.manifest).toEqual({
      name: "sales",
      namespace: "apps",
      displayName: "Sales",
      description: "Quarterly numbers",
      thumbnail: undefined,
      runtime: { replicas: 1, env: [], resources: null, pixiTask: "" },
      access: { public: false, groups: ["analytics", "finance"], subdomain: "sales" },
    });
    expect(payload.manifest).not.toHaveProperty("landingPage");
  });

  it("opts into the landing page explicitly", async () => {
    const { user, onSubmit, submit } = setup();
    await user.type(screen.getByLabelText("Name"), "sales");
    await user.type(screen.getByLabelText("Display name"), "Sales");
    await user.upload(screen.getByLabelText(/Drop a \.zip/), site());
    await user.click(screen.getByRole("switch", { name: "Show on the landing page" }));
    await submit();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.kind === "upload" && payload.manifest.landingPage).toEqual({ enabled: true });
  });

  it("launches from git with resources, env and a public URL", async () => {
    const { user, onSubmit, submit, error } = setup();
    await user.type(screen.getByLabelText("Name"), "docs");
    await user.type(screen.getByLabelText("Display name"), "Docs");
    await user.click(screen.getByRole("tab", { name: "Git" }));
    expect(error()).toBe("Enter the git repository URL.");
    await user.type(screen.getByLabelText("Repository URL"), "https://github.com/org/docs");
    await user.type(screen.getByLabelText("Subdirectory"), "site");
    await user.click(screen.getByRole("button", { name: "Medium" }));
    await user.click(screen.getByRole("button", { name: /Add variable/ }));
    await user.type(screen.getByLabelText("Variable 1 name"), "LOG_LEVEL");
    await user.type(screen.getByLabelText("Value of LOG_LEVEL"), "debug");
    // An empty row is dropped rather than sent.
    await user.click(screen.getByRole("button", { name: /Add variable/ }));
    await user.click(screen.getByRole("switch", { name: "Public app" }));
    await submit();

    const payload = onSubmit.mock.calls[0][0];
    if (payload.kind !== "create") throw new Error(`expected a create, got ${payload.kind}`);
    expect(payload.body.source).toEqual({
      type: "git",
      git: { url: "https://github.com/org/docs", ref: "main", subdir: "site" },
    });
    expect(payload.body.runtime).toEqual({
      replicas: 1,
      env: [{ name: "LOG_LEVEL", value: "debug" }],
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "500m", memory: "1Gi" },
      },
      pixiTask: "",
    });
    expect(payload.body.access).toEqual({ public: true, groups: [], subdomain: "docs" });
    expect(screen.getByText("https://docs.apps.example.ai")).toBeInTheDocument();
  });

  it("requires a PVC claim name for PVC sources", async () => {
    const { user, onSubmit, submit, error } = setup();
    await user.type(screen.getByLabelText("Name"), "data");
    await user.type(screen.getByLabelText("Display name"), "Data");
    await user.click(screen.getByRole("tab", { name: "PVC" }));
    expect(error()).toBe("Enter the PVC claim name.");
    await user.type(screen.getByLabelText("Claim name"), "team-share");
    await submit();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.kind === "create" && payload.body.source).toEqual({
      type: "pvc",
      pvc: { claimName: "team-share", subPath: undefined },
    });
  });

  it("needs a launch task and a .zip for pixi apps", async () => {
    // Bypass the input's accept filter, as a drag-and-drop or a picker set to
    // "All files" would.
    const { user, onSubmit, submit, error } = setup({}, { applyAccept: false });
    await user.type(screen.getByLabelText("Name"), "api");
    await user.type(screen.getByLabelText("Display name"), "API");
    await user.click(screen.getByRole("combobox", { name: "App type" }));
    await user.click(await screen.findByRole("option", { name: "Python app (pixi)" }));
    expect(error()).toBe("Enter the pixi task that launches the app.");
    await user.type(screen.getByLabelText("Launch task"), "start");
    expect(error()).toBe("Choose a .zip of your pixi project to upload.");
    // Single-file .html uploads only make sense for static sites.
    await user.upload(
      screen.getByLabelText(/Drop a \.zip/),
      new File(["x"], "index.html", { type: "text/html" }),
    );
    expect(error()).toBe("Pixi apps must be uploaded as a .zip archive.");
    await user.upload(screen.getByLabelText(/index\.html/), new File(["x"], "app.zip"));
    await submit();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.kind === "upload" && payload.manifest.runtime?.pixiTask).toBe("start");
  });
});

const EXISTING: App = {
  name: "docs-site",
  namespace: "apps",
  displayName: "Docs Site",
  description: "Team docs",
  thumbnail: "",
  owner: "alice",
  createdAt: "2026-10-19T12:00:00Z",
  source: { type: "inline", inline: { files: { "index.html": "<h1>hi</h1>" } } },
  runtime: {
    replicas: 2,
    env: [{ name: "LOG_LEVEL", value: "info" }],
    resources: {
      requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "1Gi" },
      limits: { memory: "512Mi", "nvidia.com/gpu": "1" },
    },
  },
  access: { public: false, groups: ["analytics"], subdomain: "docs-site" },
  status: { phase: "Running", url: "", conditions: [], message: "" },
} as unknown as App;

describe("AppForm (edit)", () => {
  it("patches what the form edits, keeps the source and is explicit about the landing page", async () => {
    const { user, onSubmit, submit } = setup({ mode: "edit", initial: EXISTING });
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Subdomain")).toBeDisabled();

    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "Docs");
    await user.clear(screen.getByLabelText("CPU request"));
    await user.type(screen.getByLabelText("CPU request"), "200m");
    await submit();

    const payload = onSubmit.mock.calls[0][0];
    if (payload.kind !== "patch") throw new Error(`expected a patch, got ${payload.kind}`);
    expect(payload.body).not.toHaveProperty("source");
    expect(payload.body.displayName).toBe("Docs");
    expect(payload.body.landingPage).toEqual({ enabled: false });
    expect(payload.body.access).toEqual({
      public: false,
      groups: ["analytics"],
      subdomain: "docs-site",
    });
    // Resources the form does not show (set with kubectl) survive the edit.
    expect(payload.body.runtime?.resources).toEqual({
      requests: { cpu: "200m", memory: "128Mi", "ephemeral-storage": "1Gi" },
      limits: { memory: "512Mi", "nvidia.com/gpu": "1" },
    });
    expect(payload.body.runtime?.replicas).toBe(2);
  });

  it("clears resources with null once every field is emptied", async () => {
    const plain = {
      ...EXISTING,
      runtime: {
        replicas: 1,
        resources: { requests: { cpu: "100m" }, limits: { memory: "256Mi" } },
      },
    } as App;
    const { user, onSubmit, submit } = setup({ mode: "edit", initial: plain });
    await user.clear(screen.getByLabelText("CPU request"));
    await user.clear(screen.getByLabelText("Memory limit"));
    await submit();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.kind === "patch" && payload.body.runtime?.resources).toBeNull();
  });

  it("switches an inline app to git", async () => {
    const { user, onSubmit, submit } = setup({ mode: "edit", initial: EXISTING });
    await user.click(screen.getByRole("tab", { name: "Git" }));
    await user.type(screen.getByLabelText("Repository URL"), "https://github.com/org/docs");
    await user.clear(screen.getByLabelText("Branch / tag"));
    await user.type(screen.getByLabelText("Branch / tag"), "v2");
    await submit();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.kind === "patch" && payload.body.source).toEqual({
      type: "git",
      git: { url: "https://github.com/org/docs", ref: "v2", subdir: undefined },
    });
  });
});
