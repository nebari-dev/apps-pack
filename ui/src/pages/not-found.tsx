import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="font-semibold text-2xl">Page not found</h1>
      <p className="text-muted-foreground text-sm">There is nothing at this address.</p>
      <Button render={<Link to="/apps">Go to apps</Link>} />
    </div>
  );
}
