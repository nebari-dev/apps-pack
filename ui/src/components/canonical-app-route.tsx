import type { ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { appPath, DEFAULT_NAMESPACE } from "@/lib/paths";

/**
 * Renders a page reached at `/apps/:namespace/:name[/suffix]`, but sends the
 * long form of a default-namespace App (`/apps/apps/<name>`, from old links and
 * bookmarks) to its short form, keeping the query string (`?tab=`) and hash.
 */
export function CanonicalAppRoute({ suffix, children }: { suffix?: string; children: ReactNode }) {
  const { namespace = "", name = "" } = useParams();
  const { search, hash } = useLocation();
  if (namespace === DEFAULT_NAMESPACE) {
    return (
      <Navigate replace to={{ pathname: appPath({ namespace, name }, suffix), search, hash }} />
    );
  }
  return children;
}
