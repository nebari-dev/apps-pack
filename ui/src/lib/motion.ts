/*
 * The app's motion vocabulary, built only from the Nebari theme's animate-*
 * utilities (durations and easings are the theme's --duration-* / --ease-*
 * tokens). Every class is gated on motion-safe:, so with
 * prefers-reduced-motion: reduce content simply appears.
 */

/** Data replacing a skeleton, a status that changed, a tab panel: a short crossfade. */
export const FADE_IN = "motion-safe:animate-fade-in";

/** Something new entering: a page after navigation, a new row, an alert. */
export const ENTER = "motion-safe:animate-slide-up-fade";
