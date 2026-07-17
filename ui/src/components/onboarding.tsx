import { BookOpen, Copy, Rocket, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { toast } from '@/ui/toast';

/** First-run guidance shown when no apps exist yet. */
export function Onboarding() {
  const mcpEndpoint = `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mcpEndpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <div>
          <h2 className="font-semibold text-lg">No apps yet</h2>
          <p className="text-muted-foreground text-sm">
            Deploy a static site (HTML/CSS/JS) or a Python app (pixi) three ways — all served behind the cluster gateway.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Step icon={<Rocket className="size-5" />} title="Launch from here">
            <p className="text-muted-foreground text-sm">Upload a .zip or point at a git repo — no YAML required.</p>
            <Button className="mt-3" size="sm" render={<Link to="/launch">Launch an app</Link>} />
          </Step>

          <Step icon={<Sparkles className="size-5" />} title="Use the MCP server">
            <p className="text-muted-foreground text-sm">Add this endpoint as a connector in Claude to launch and manage apps in chat.</p>
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{mcpEndpoint}</code>
              <Button variant="outline" size="icon-sm" aria-label="Copy MCP endpoint" onClick={copy}>
                <Copy className={copied ? 'text-success-foreground' : ''} />
              </Button>
            </div>
          </Step>

          <Step icon={<BookOpen className="size-5" />} title="Scaffold with the skill">
            <p className="text-muted-foreground text-sm">
              In Claude Code, run <span className="font-mono">/new-nebari-app</span> to scaffold an app with a launch manifest.
            </p>
          </Step>
        </div>
      </CardContent>
    </Card>
  );
}

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-accent p-1.5 text-accent-foreground">{icon}</span>
        <h3 className="font-medium text-sm">{title}</h3>
      </div>
      {children}
    </div>
  );
}
