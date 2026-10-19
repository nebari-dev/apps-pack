import { useCallback, useEffect, useRef } from "react";
import { getBranding } from "@/lib/branding";

// The first page after a full load keeps the browser's own focus; only
// client-side navigations move it, as a page load would.
let navigated = false;

/**
 * Names the page for the tab and for assistive tech: sets document.title to
 * "<title> · <app title>" and, after a client-side navigation, moves focus to
 * the page heading once it renders (pages show a spinner first), so screen
 * readers announce the new page. Pass the returned ref to the page's <h1>,
 * which needs tabIndex={-1}.
 */
export function usePageTitle(title: string) {
  useEffect(() => {
    const app = getBranding().title || "Nebari Apps";
    document.title = title ? `${title} · ${app}` : app;
  }, [title]);

  const pending = useRef(navigated);
  useEffect(() => {
    navigated = true;
  }, []);

  return useCallback((heading: HTMLHeadingElement | null) => {
    if (heading && pending.current) {
      pending.current = false;
      heading.focus();
    }
  }, []);
}
