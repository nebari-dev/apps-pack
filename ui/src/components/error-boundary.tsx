import { AlertCircle, RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface State {
  error: Error | null;
}

/**
 * Catches a page that throws while rendering, so the header and navigation
 * stay usable and the user gets a way out. Keyed by route in Layout, so
 * navigating elsewhere clears it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>This page failed to load</AlertTitle>
        <AlertDescription>{this.state.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RotateCw aria-hidden="true" /> Reload
          </Button>
        </AlertAction>
      </Alert>
    );
  }
}
