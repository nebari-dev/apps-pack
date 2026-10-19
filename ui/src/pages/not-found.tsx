import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/hooks/use-page-title";

export function NotFoundPage() {
  const heading = usePageTitle("Page not found");
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
        Page not found
      </h1>
      <p className="text-muted-foreground text-sm">There is nothing at this address.</p>
      <Button render={<Link to="/apps">Go to apps</Link>} />
    </div>
  );
}
