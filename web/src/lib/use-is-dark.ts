import { useEffect, useState } from "react";

/**
 * Tracks whether the site is in dark mode by watching the `dark` class on
 * `<html>`, which the theme toggle in `Layout.astro` flips. Client-only —
 * returns `false` until mounted.
 */
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}
