import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bug, Check, Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { sourceLabel } from "@/components/app-bits";
import { LoadingStatus, PillSkeleton, TextLine } from "@/components/loading-skeletons";
import { QueryError } from "@/components/query-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { useArrived } from "@/hooks/use-changed";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api";
import { getConfig } from "@/lib/auth";
import { getBranding } from "@/lib/branding";
import { copyText } from "@/lib/clipboard";
import { FADE_IN } from "@/lib/motion";
import type { ApiVersion, Capabilities, Me, UiConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

const REPO = "https://github.com/nebari-dev/apps-pack";
const DOCS = "https://packs.nebari.dev/apps-pack/";
export const LINKS = {
  docs: DOCS,
  changelog: `${REPO}/blob/main/CHANGELOG.md`,
  mcpDocs: `${DOCS}mcp/`,
  skillDocs: `${DOCS}skill/`,
};

/** "0.2.0 (sha-abc1234)", or just the version when the build adds nothing. */
export function versionLine(version?: string, build?: string): string {
  if (!version) return "unknown";
  return build && build !== version ? `${version} (${build})` : version;
}

type Build = { version?: string; build?: string };

/**
 * The UI's own release (baked in from ui/package.json at build time) and the
 * image tag its pod runs (rendered into /config.json by the chart; absent
 * outside it, e.g. with ui.existingConfigMap or in local development).
 */
export function uiBuild(): Build {
  const { build } = getBranding();
  return {
    version: import.meta.env.UI_VERSION,
    build: typeof build === "string" && build ? build : undefined,
  };
}

const known = (value?: string) => !!value && value !== "unknown";

/**
 * Whether the UI and the API report different releases or images, as during a
 * rollout. A build either side does not know is not compared.
 */
export function buildsDiffer(ui: Build, apiVersion?: ApiVersion): boolean {
  if (!apiVersion) return false;
  if (known(ui.version) && known(apiVersion.version) && ui.version !== apiVersion.version) {
    return true;
  }
  return known(ui.build) && known(apiVersion.build) && ui.build !== apiVersion.build;
}

/**
 * A new bug report on GitHub with the "Pack version" field filled in. GitHub
 * issue forms take a field's id as a query parameter.
 */
export function bugReportUrl(ui: Build, apiVersion?: ApiVersion) {
  const lines = [`UI ${versionLine(ui.version, ui.build)}`];
  if (apiVersion) lines.push(`API ${versionLine(apiVersion.version, apiVersion.build)}`);
  const params = new URLSearchParams({ template: "bug-report.yml", version: lines.join(", ") });
  return `${REPO}/issues/new?${params}`;
}

/** "30 minutes", "1 hour", "2 hours"; 0 is off. */
export function idleTimeoutLine(minutes?: number): string {
  if (!minutes) return "Off: Apps stay up unless they set their own timeout";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function SettingsPage() {
  const heading = usePageTitle("Settings");
  const version = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: Infinity });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });
  const loading = version.isPending || me.isPending || capabilities.isPending;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
          Settings
        </h1>
        <p className="mt-1 text-muted-foreground text-sm">
          This install's versions, your account, the cluster's settings and how to connect an agent.
        </p>
      </div>
      {loading ? <LoadingStatus label="Loading settings" /> : null}

      <About apiVersion={version} />
      <Account me={me} />
      <Cluster capabilities={capabilities} />
      <ConnectAgent />
    </div>
  );
}

type Query<T> = {
  data?: T;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={id}>{title}</h2>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </section>
  );
}

/** A label/value list that stacks below sm. */
function Fields({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-y-2">
      {children}
    </dl>
  );
}

/**
 * One label and its value. The label is real at once; while `loading`, the
 * value is a placeholder, and the value fades in when it replaces one.
 */
function Field({
  label,
  loading = false,
  arrived = false,
  skeleton = <TextLine className="w-32" />,
  children,
}: {
  label: string;
  loading?: boolean;
  arrived?: boolean;
  skeleton?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 max-sm:mb-2">
        {loading ? skeleton : <div className={cn(arrived && FADE_IN)}>{children}</div>}
      </dd>
    </div>
  );
}

function Pills({ items, mono = false }: { items: string[]; mono?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item}>
          <Badge
            variant="ghost"
            className={cn("border border-border", mono && "font-mono", "max-w-full truncate")}
          >
            {item}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

const pillsSkeleton = (
  <div aria-hidden="true" className="flex h-5.5 gap-1.5">
    <PillSkeleton />
    <PillSkeleton className="w-20" />
  </div>
);

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      variant="outline"
      size="sm"
      render={
        <a href={href} target="_blank" rel="noreferrer">
          {children}
          <ExternalLink aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      }
    />
  );
}

function About({ apiVersion }: { apiVersion: Query<ApiVersion> }) {
  const ui = uiBuild();
  const arrived = useArrived(!apiVersion.isPending);
  const differ = buildsDiffer(ui, apiVersion.data);
  return (
    <Section
      id="settings-about"
      title="About"
      description="Include both versions when you report a problem."
    >
      <Fields>
        <Field label="UI version">
          <span className="font-mono">{ui.version ?? "unknown"}</span>
        </Field>
        <Field label="UI build">
          <span className="font-mono">{ui.build ?? "unknown"}</span>
        </Field>
        <Field label="API version" loading={apiVersion.isPending} arrived={arrived}>
          <span className="font-mono">
            {apiVersion.data?.version ?? (apiVersion.isError ? "Could not load" : "unknown")}
          </span>
        </Field>
        <Field label="API build" loading={apiVersion.isPending} arrived={arrived}>
          <span className="font-mono">
            {apiVersion.data?.build ?? (apiVersion.isError ? "Could not load" : "unknown")}
          </span>
        </Field>
      </Fields>
      {differ ? (
        <Alert variant="warning" className={cn(arrived && FADE_IN)}>
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>
            The UI and API are on different builds. A rollout may be in progress; reload in a
            minute, and if they still differ, mention it in your report.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ExternalButton href={LINKS.docs}>Documentation</ExternalButton>
        <ExternalButton href={LINKS.changelog}>Changelog</ExternalButton>
        <ExternalButton href={bugReportUrl(ui, apiVersion.data)}>
          <Bug aria-hidden="true" />
          Report a bug
        </ExternalButton>
      </div>
    </Section>
  );
}

function Account({ me }: { me: Query<Me> }) {
  const { authEnabled } = getConfig();
  const arrived = useArrived(!me.isPending);
  const data = me.data;
  return (
    <Section
      id="settings-account"
      title="Your account"
      description={
        authEnabled ? (
          <>
            Your groups come from your sign-in, as full Keycloak group paths. A restricted App opens
            for members of any group it lists (a group does not include its subgroups); you can
            manage the Apps you own and those whose managers include you or one of your groups.
            Admins can manage every App.
          </>
        ) : (
          <>Sign-in is off on this cluster, so everyone can see and manage every App.</>
        )
      }
    >
      {me.isError ? (
        <QueryError title="Could not load your account" error={me.error} onRetry={me.refetch} />
      ) : (
        <Fields>
          <Field label="Username" loading={me.isPending} arrived={arrived}>
            {data?.username}
          </Field>
          <Field label="Email" loading={me.isPending} arrived={arrived}>
            {data?.email || <span className="text-muted-foreground">Not set</span>}
          </Field>
          <Field label="Groups" loading={me.isPending} arrived={arrived} skeleton={pillsSkeleton}>
            {data?.groups.length ? (
              <Pills items={data.groups} />
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Field>
          <Field
            label="Admin"
            loading={me.isPending}
            arrived={arrived}
            skeleton={<TextLine className="w-10" />}
          >
            {data?.admin ? "Yes" : "No"}
          </Field>
        </Fields>
      )}
    </Section>
  );
}

function Cluster({ capabilities }: { capabilities: Query<Capabilities> }) {
  const arrived = useArrived(!capabilities.isPending);
  const data = capabilities.data;
  const loading = capabilities.isPending;
  const registries = data?.imageRegistries ?? [];
  return (
    <Section
      id="settings-cluster"
      title="Cluster"
      description="Set by the cluster's administrators in the pack's Helm values."
    >
      {capabilities.isError ? (
        <QueryError
          title="Could not load the cluster's settings"
          error={capabilities.error}
          onRetry={capabilities.refetch}
        />
      ) : (
        <Fields>
          <Field
            label="Apps domain"
            loading={loading}
            arrived={arrived}
            skeleton={<TextLine className="w-40" />}
          >
            <span className="break-all font-mono">{data?.appsDomain || "Not set"}</span>
          </Field>
          <Field label="Namespaces" loading={loading} arrived={arrived} skeleton={pillsSkeleton}>
            {data?.namespaces.length ? (
              <Pills items={data.namespaces} mono />
            ) : (
              <span className="text-muted-foreground">None you can launch into</span>
            )}
          </Field>
          <Field label="Default idle timeout" loading={loading} arrived={arrived}>
            {idleTimeoutLine(data?.idleTimeoutMinutes)}
          </Field>
          <Field label="Source types" loading={loading} arrived={arrived} skeleton={pillsSkeleton}>
            <Pills items={(data?.sourceTypes ?? []).map(sourceLabel)} />
          </Field>
          <Field
            label="Image registries"
            loading={loading}
            arrived={arrived}
            skeleton={pillsSkeleton}
          >
            {registries.length ? (
              <Pills items={registries} mono />
            ) : (
              <span className="text-muted-foreground">Image Apps are off</span>
            )}
          </Field>
        </Fields>
      )}
    </Section>
  );
}

/** A value to paste somewhere, with a copy button that uses the clipboard fallback. */
function CopyField({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.add({ type: "success", title: `Copied the ${label.toLowerCase()}` });
    } catch {
      toast.add({ type: "error", title: "Could not copy to clipboard" });
    }
  };
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-sm">{label}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs leading-5">
          {value}
        </code>
        <Button variant="outline" size="icon-sm" aria-label={copyLabel} onClick={() => void copy()}>
          {copied ? <Check className="text-success-foreground" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The `claude mcp add` command. With auth on and an MCP OAuth client
 * configured, Claude Code signs in with that client: Keycloak only accepts
 * its registered redirect URI, hence the fixed callback port.
 */
export function claudeCommand(mcpUrl: string, config: UiConfig): string {
  const oauth = config.authEnabled ? config.mcpOAuth : undefined;
  const flags = oauth?.clientId
    ? ` --client-id ${oauth.clientId}${oauth.callbackPort ? ` --callback-port ${oauth.callbackPort}` : ""}`
    : "";
  return `claude mcp add --transport http${flags} nebari-apps ${mcpUrl}`;
}

function ConnectAgent() {
  // The UI's nginx proxies /mcp to the MCP server, so it shares the UI's host.
  const mcpUrl = `${window.location.origin}/mcp`;
  const command = claudeCommand(mcpUrl, getConfig());
  return (
    <Section
      id="settings-agent"
      title="Connect an agent"
      description={
        <>
          Coding agents launch and manage your Apps through the MCP server, with the same access you
          have here.
          {getConfig().authEnabled
            ? " The agent asks you to sign in in your browser the first time."
            : null}
        </>
      }
    >
      <CopyField label="MCP server URL" value={mcpUrl} copyLabel="Copy MCP server URL" />
      <CopyField label="Claude Code command" value={command} copyLabel="Copy Claude Code command" />
      <p className="text-muted-foreground text-sm">
        In Claude Code, the <span className="font-mono">new-nebari-app</span> skill scaffolds an app
        with a launch manifest and launches it through this server.
      </p>
      <div className="flex flex-wrap gap-2">
        <ExternalButton href={LINKS.mcpDocs}>MCP server docs</ExternalButton>
        <ExternalButton href={LINKS.skillDocs}>Skill docs</ExternalButton>
      </div>
    </Section>
  );
}
