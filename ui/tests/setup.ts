import '@testing-library/jest-dom/vitest';

// jsdom does not implement ResizeObserver, which Base UI popups rely on for
// positioning.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
