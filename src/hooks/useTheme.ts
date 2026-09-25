import { useAtomValue } from "jotai";
import { reducedMotionAtom } from "#store/ui";

/**
 * Subscribes to the OS `prefers-reduced-motion` preference. The atom
 * itself reads the media query and listens for changes while mounted
 * (see `reducedMotionAtom`); calling this at the app root keeps that
 * listener mounted for the app's lifetime.
 */
export function useTheme(): { reducedMotion: boolean } {
  return { reducedMotion: useAtomValue(reducedMotionAtom) };
}
