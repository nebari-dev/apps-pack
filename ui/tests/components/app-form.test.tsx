import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppForm, type SubmitPayload } from "@/components/app-form";
import type { App } from "@/lib/types";

function setup(
  props: Partial<Parameters<typeof AppForm>[0]> = {},
  userOptions: Parameters<typeof userEvent.setup>[0] = {},
) {
  const onSubmit = vi.fn<(p: SubmitPayload) => void>();
  const onCancel = vi.fn<() => void>();
  const user = userEvent.setup(userOptions);
  render(
    <AppForm
      mode="create"
      namespaces={["apps", "team-a"]}
      appsDomain="apps.example.ai"
      appsScheme="https"
      submitting={false}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />,
  );
  const submit = () =>
    user.click(
      screen.getByRole("button", { name: props.mode === "edit" ? "Save changes" : "Launch app" }),
    );
  /** The message under a field, or "" when none is shown. */
  const error = (field: string) => document.getElementById(`${field}-error`)?.textContent ?? "";
  return { user, onSubmit, onCancel, submit, error };
}

const site = () => new File(["<h1>hi</h1>"], "site.zip", { type: "application/zip" });

describe("AppForm (create)", () => {
  it("shows nothing invalid on first render and keeps submit enabled", () => {
    setup();
    expect(document.querySelectorAll("[aria-invalid]")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Launch app" })).toBeEnabled();
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      "Lowercase letters, digits and hyphens. Also used as the default subdomain.",
    );
  });

  it("shows a field's message under it once the field is left", async () => {
    const { user, error } = setup();
    const name = screen.getByLabelText("Name");
    await user.type(name, "Not Valid");
    // Typing alone does not flag the field.
    expect(name).not.toHaveAttribute("aria-invalid");
    await user.tab();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(error("name")).toBe("Name must be lowercase letters, digits, and hyphens.");
    expect(name).toHaveAccessibleDescription(
      "Lowercase letters, digits and hyphens. Also used as the default subdomain. Name must be lowercase letters, digits, and hyphens.",
    );
    // Other fields stay quiet until they are touched.
    expect(screen.getByLabelText("Display name")).not.toHaveAttribute("aria-invalid");
    await user.clear(name);
    await user.type(name, "valid-name");
    expect(name).not.toHaveAttribute("aria-invalid");
    expect(error("name")).toBe("");
  });

  it("on submit shows every problem, announces the count and focuses the first", async () => {
    const { user, onSubmit, submit, error } = setup();
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(error("name")).toBe("Give the app a name.");
    expect(error("displayName")).toBe("Give the app a display name.");
    expect(error("file")).toBe("Choose a .zip or .html file to upload.");
    expect(error("subdomain")).toBe("Pick a subdomain.");
    expect(screen.getByText("4 problems to fix")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByLabelText(/Drop a \.zip/)).toHaveAttribute("aria-describedby", "file-error");

    await user.type(screen.getByLabelText("Name"), "sales");
    await user.type(screen.getByLabelText("Display name"), "Sales");
    await submit();
    expect(screen.getByLabelText(/Drop a \.zip/)).toHaveFocus();
    expect(screen.getByText("1 problem to fix")).toBeInTheDocument();
  });

  it("mirrors a slugified name into the subdomain until it is edited", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Name"), "Sales Dashboard!");
    expect(screen.getByLabelText("Subdomain")).toHaveValue("sales-dashboard");
    expect(screen.getByTestId("url-preview")).toHaveTextContent(
      "https://sales-dashboard.apps.example.ai",
    );
    await user.clear(screen.getByLabelText("Subdomain"));
    await user.type(screen.getByLabelText("Subdomain"), "reports");
    await user.type(screen.getByLabelText("Name"), "x");
    expect(screen.getByLabelText("Subdomain")).toHaveValue("reports");
  });

  it("rejects a subdomain that is not a DNS label", async () => {
    const { user, error } = setup();
    await user.type(screen.getByLabelText("Name"), "sales");
    await user.clear(screen.getByLabelText("Subdomain"));
    await user.type(screen.getByLabelText("Subdomain"), "-sales");
    await user.tab();
    expect(error("subdomain")).toBe("Subdomain must be lowercase letters, digits, and hyphens.");
    expect(screen.getByLabelText("Subdomain")).toHaveAttribute(
      "aria-describedby",
      "subdomain-error",
    );
  });

  it("cancels through onCancel", async () => {
    const { user, onCancel, onSubmit } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps replicas, resources and the port rule in a closed Advanced disclosure", async () => {
    const { user } = setup();
    const summary = screen.getByText("Advanced");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent(
      "Python apps must serve on 0.0.0.0:$PORT (8080, or 8081 when groups or users restrict the app or it can idle).",
    );
    for (const label of [
      "Replicas",
      "CPU request",
      "Memory request",
      "CPU limit",
      "Memory limit",
      "Idle timeout (minutes)",
    ])
      expect(details).toContainElement(screen.getByLabelText(label));
    // Environment variables stay outside it.
    expect(details).not.toContainElement(screen.getByRole("button", { name: /Add variable/ }));
    await user.click(summary);
    expect(details).toHaveAttribute("open");
    expect(details).toContainElement(screen.getByRole("button", { name: "Small" }));
  });

  it("marks the preset that matches the current resources as pressed", async () => {
    const { user } = setup();
    await user.click(screen.getByText("Advanced"));
    const medium = screen.getByRole("button", { name: "Medium" });
    expect(medium).toHaveAttribute("aria-pressed", "false");
    await user.click(medium);
    expect(medium).toHaveAttribute("aria-pressed", "true");
    expect(medium).toHaveAttribute("data-variant", "secondary");
    expect(screen.getByRole("button", { name: "Small" })).toHaveAttribute("aria-pressed", "false");
    // Tweaking a field leaves the preset.
    await user.type(screen.getByLabelText("CPU limit"), "0");
    expect(medium).toHaveAttribute("aria-pressed", "false");
    expect(medium).toHaveAttribute("data-variant", "outline");
  });

  it("explains jargon in tooltips", () => {
    setup();
    expect(screen.getByRole("tab", { name: "Volume (PVC)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About PVC" })).toBeInTheDocument();
  });

  it("submits an upload with the manifest, allowed groups and users, and no landing tile", async () => {
    const { user, onSubmit, submit } = setup();
    await user.type(screen.getByLabelText("Name"), "sales");
    await user.type(screen.getByLabelText("Display name"), "Sales");
    await user.type(screen.getByLabelText("Description"), "Quarterly numbers");
    await user.type(screen.getByLabelText("Allowed groups"), "analytics, finance ,");
    await user.type(screen.getByLabelText("Allowed users"), " alice,bob ");
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
      access: {
        public: false,
        groups: ["analytics", "finance"],
        users: ["alice", "bob"],
        subdomain: "sales",
      },
      // The landing-page switch is locked: new apps are registered off.
      landingPage: { enabled: false },
    });
  });

  it("describes who the groups and users fields let in", () => {
    setup();
    expect(screen.getByLabelText("Allowed groups")).toHaveAccessibleDescription(
      /Only members of these Keycloak groups can open the app; everyone else gets 403/,
    );
    expect(screen.getByLabelText("Allowed users")).toHaveAccessibleDescription(
      "Keycloak usernames who can open the app even if they are not in an allowed group.",
    );
  });

  it("shows the locked landing-page option as a note, not a switch", () => {
    setup();
    expect(screen.queryByRole("switch", { name: /landing page/ })).toBeNull();
    expect(
      screen.getByText(/Not listed\. Changing this here is not available yet\./),
    ).toBeVisible();
  });

  it("launches from git with resources, env and a public URL", async () => {
    const { user, onSubmit, submit } = setup();
    await user.type(screen.getByLabelText("Name"), "docs");
    await user.type(screen.getByLabelText("Display name"), "Docs");
    await user.click(screen.getByRole("tab", { name: "Git" }));
    await user.type(screen.getByLabelText("Repository URL"), "https://github.com/org/docs");
    await user.type(screen.getByLabelText("Subdirectory"), "site");
    await user.click(screen.getByText("Advanced"));
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
    expect(payload.body.access).toEqual({ public: true, groups: [], users: [], subdomain: "docs" });
    expect(screen.getByTestId("url-preview")).toHaveTextContent("https://docs.apps.example.ai");
  });

  it("requires a PVC claim name for PVC sources", async () => {
    const { user, onSubmit, submit, error } = setup();
    await user.type(screen.getByLabelText("Name"), "data");
    await user.type(screen.getByLabelText("Display name"), "Data");
    await user.click(screen.getByRole("tab", { name: "Volume (PVC)" }));
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(error("pvcClaim")).toBe("Enter the PVC claim name.");
    expect(screen.getByLabelText("Claim name")).toHaveFocus();
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
    expect(screen.getByLabelText("Launch task")).toHaveAccessibleDescription(
      "The pixi task that starts your server.",
    );
    expect(screen.getByRole("button", { name: "About Launch task" })).toBeInTheDocument();
    await submit();
    expect(error("pixiTask")).toBe("Enter the pixi task that launches the app.");
    expect(error("file")).toBe("Choose a .zip of your pixi project to upload.");
    await user.type(screen.getByLabelText("Launch task"), "start");
    expect(error("pixiTask")).toBe("");
    // Single-file .html uploads only make sense for static sites.
    await user.upload(
      screen.getByLabelText(/Drop a \.zip/),
      new File(["x"], "index.html", { type: "text/html" }),
    );
    expect(error("file")).toBe("Pixi apps must be uploaded as a .zip archive.");
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
  it("patches what the form edits and keeps the source and the landing page", async () => {
    const { user, onSubmit, submit } = setup({ mode: "edit", initial: EXISTING });
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Subdomain")).toBeDisabled();
    expect(screen.getAllByTitle("Fixed after launch")).toHaveLength(2);
    // The inline source is named, not shown as a raw type.
    expect(screen.getByText("Uploaded files")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "Docs");
    await user.clear(screen.getByLabelText("CPU request"));
    await user.type(screen.getByLabelText("CPU request"), "200m");
    await submit();

    const payload = onSubmit.mock.calls[0][0];
    if (payload.kind !== "patch") throw new Error(`expected a patch, got ${payload.kind}`);
    expect(payload.body).not.toHaveProperty("source");
    expect(payload.body.displayName).toBe("Docs");
    expect(payload.body).not.toHaveProperty("landingPage");
    expect(payload.body.access).toEqual({
      public: false,
      groups: ["analytics"],
      users: [],
      subdomain: "docs-site",
    });
    // Resources the form does not show (set with kubectl) survive the edit.
    expect(payload.body.runtime?.resources).toEqual({
      requests: { cpu: "200m", memory: "128Mi", "ephemeral-storage": "1Gi" },
      limits: { memory: "512Mi", "nvidia.com/gpu": "1" },
    });
    expect(payload.body.runtime?.replicas).toBe(2);
  });

  it("round-trips allowed users and never changes a registered tile", async () => {
    const listed = {
      ...EXISTING,
      access: { public: false, groups: [], users: ["alice", "bob"], subdomain: "docs-site" },
      landingPage: { enabled: true },
    } as App;
    const { user, onSubmit, submit } = setup({ mode: "edit", initial: listed });
    expect(screen.getByText(/^Listed\./)).toBeInTheDocument();
    const users = screen.getByLabelText("Allowed users");
    expect(users).toHaveValue("alice, bob");
    await user.clear(users);
    await user.type(users, "carol");
    await submit();

    const payload = onSubmit.mock.calls[0][0];
    if (payload.kind !== "patch") throw new Error(`expected a patch, got ${payload.kind}`);
    expect(payload.body.access).toEqual({
      public: false,
      groups: [],
      users: ["carol"],
      subdomain: "docs-site",
    });
    expect(payload.body).not.toHaveProperty("landingPage");
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

  it("opens Advanced on an edit only when replicas or resources are not the defaults", () => {
    const details = () => screen.getByText("Advanced").closest("details");
    setup({ mode: "edit", initial: EXISTING });
    expect(details()).toHaveAttribute("open");
    cleanup();
    setup({ mode: "edit", initial: { ...EXISTING, runtime: { replicas: 1 } } as App });
    expect(details()).not.toHaveAttribute("open");
  });

  it.each([
    [
      { type: "git", git: { url: "https://github.com/org/docs", ref: "v2", subdir: "site" } },
      ["https://github.com/org/docs", "v2", "site"],
    ],
    [{ type: "pvc", pvc: { claimName: "team-share", subPath: "docs/" } }, ["team-share", "docs/"]],
  ])("shows the current %o source", (source, shown) => {
    setup({ mode: "edit", initial: { ...EXISTING, source } as App });
    const panel = screen.getByRole("tabpanel", { name: "Keep current" });
    for (const text of shown) expect(panel).toHaveTextContent(text);
  });

  it("cancels an edit through onCancel", async () => {
    const { user, onCancel } = setup({ mode: "edit", initial: EXISTING });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
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
