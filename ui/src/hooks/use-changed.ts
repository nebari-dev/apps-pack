import { useState } from "react";

/**
 * True from the first render where `value` differs from the one the component
 * mounted with, and from then on. Motion uses it to animate a change (a new
 * route, a new status, data replacing a placeholder) but never the first paint.
 */
export function useChanged<T>(value: T): boolean {
  const [prev, setPrev] = useState(value);
  const [changed, setChanged] = useState(false);
  // Adjusting state while rendering (React's documented pattern for state
  // derived from a previous prop): React re-renders before committing.
  if (!Object.is(prev, value)) {
    setPrev(value);
    if (!changed) setChanged(true);
  }
  return changed || !Object.is(prev, value);
}

/**
 * True once content is `ready` after the component mounted without it, i.e.
 * the content replaced a loading placeholder. Content that was ready on mount
 * (cached data) returns false, so it is not faded in again.
 */
export function useArrived(ready: boolean): boolean {
  return useChanged(ready) && ready;
}
