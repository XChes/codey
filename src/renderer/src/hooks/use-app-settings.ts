import { useCallback, useEffect, useState } from "react";
import type { AppSettings, ThemePreference } from "../../../shared/settings";

function setDocumentTheme(theme: ThemePreference): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const dark = theme === "dark" || (theme === "system" && media.matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };

  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.desktop.settings
      .get()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch(() => {
        if (active) setError("Settings could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    return setDocumentTheme(settings.theme);
  }, [settings]);

  const updateTheme = useCallback(async (theme: ThemePreference) => {
    setSaving(true);
    setError(null);
    try {
      const value = await window.desktop.settings.update({ theme });
      setSettings(value);
    } catch {
      setError("Theme preference could not be saved.");
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, loading, saving, error, updateTheme };
}

