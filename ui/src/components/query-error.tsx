import { AlertCircle, RotateCw } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Why a request failed, in words: the API's detail when it gave one. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The error state for a page whose data did not load. Shown instead of an
 * empty state, so a 401 or 500 never reads as "no apps" or "no metrics".
 */
export function QueryError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" /> Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}
