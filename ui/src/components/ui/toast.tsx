import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const toastManager = ToastPrimitive.createToastManager();

/**
 * Imperative toast helpers, callable from anywhere (mutation callbacks, event
 * handlers) — no hook or context needed. Rendered by the app-level
 * {@link Toaster}.
 */
const toast = {
  success(title: string, description?: string) {
    return toastManager.add({ type: 'success', title, description });
  },
  // Errors are announced urgently and stick around longer so the message can
  // actually be read.
  error(title: string, description?: string) {
    return toastManager.add({
      type: 'error',
      title,
      description,
      priority: 'high',
      timeout: 8_000,
    });
  },
};

function ToastIcon({ type }: { type?: string }) {
  if (type === 'success') {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />;
  }
  if (type === 'error') {
    return <XCircle className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />;
  }
  return null;
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((t) => (
    <ToastPrimitive.Root
      key={t.id}
      toast={t}
      data-slot="toast"
      className={cn(
        'absolute right-0 bottom-0 flex w-full select-none items-start gap-2.5 rounded-md border border-border bg-popover bg-clip-padding p-3 pr-8 text-popover-foreground shadow-lg',
        // Collapsed stack: newest toast sits on top, older ones peek out
        // behind it, nudged up and scaled down by their index. The swipe
        // offsets keep swipe-to-dismiss tracking the pointer.
        'z-[calc(1000-var(--toast-index))] [--gap:0.625rem] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+min(var(--toast-index),10)*-0.875rem))_scale(max(0,1-var(--toast-index)*0.05))]',
        // Invisible spacer above each toast bridging the expanded gap, so the
        // stack stays hovered (expanded) while the pointer moves between toasts.
        'after:absolute after:bottom-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-[""]',
        // Expanded (hover/focus) layout: full-height list with a fixed gap.
        'data-[expanded]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(-1*var(--toast-offset-y)+var(--toast-index)*-1*var(--gap)+var(--toast-swipe-movement-y)))]',
        'data-[starting-style]:[transform:translateY(150%)]',
        'data-[ending-style]:opacity-0 data-[ending-style]:[transform:translateY(150%)] data-[ending-style]:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))]',
        'data-[limited]:opacity-0',
        'motion-safe:transition-[transform,opacity] motion-safe:duration-[var(--duration-slow)] motion-safe:ease-[var(--ease-emphasized)]',
      )}
    >
      <ToastIcon type={t.type} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <ToastPrimitive.Title className="font-medium text-sm" />
        <ToastPrimitive.Description className="break-words text-muted-foreground text-sm" />
      </div>
      <ToastPrimitive.Close
        aria-label="Dismiss notification"
        className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}

/**
 * App-level toast outlet. Mount once (next to the router); fire notifications
 * from anywhere with {@link toast}. Toasts stack bottom-right, expand on
 * hover, and can be swiped away.
 */
function Toaster() {
  return (
    <ToastPrimitive.Provider toastManager={toastManager}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-slot="toast-viewport"
          className="fixed right-4 bottom-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] sm:right-6 sm:bottom-6"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export { toast, Toaster };
