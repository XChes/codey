import { useEffect, useState } from "react";
import { KeyRound, Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  PROVIDERS,
  type Provider,
  type ProviderCredentialStatus,
} from "../../../shared/provider-credentials";
import type { ThemePreference } from "../../../shared/settings";

const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  xai: "xAI",
};

interface SettingsPageProps {
  theme: ThemePreference;
  saving: boolean;
  error: string | null;
  onThemeChange(theme: ThemePreference): void;
}

export function SettingsPage({
  theme,
  saving,
  error,
  onThemeChange,
}: SettingsPageProps) {
  const [credentialStatuses, setCredentialStatuses] = useState<
    ProviderCredentialStatus[]
  >([]);
  const [credentialValues, setCredentialValues] = useState<
    Record<Provider, string>
  >({ deepseek: "", openai: "", xai: "" });
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.desktop.credentials
      .list()
      .then((statuses) => {
        if (active) setCredentialStatuses(statuses);
      })
      .catch(() => {
        if (active) {
          setCredentialError("Provider credentials could not be loaded.");
        }
      })
      .finally(() => {
        if (active) setCredentialsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateCredentialStatus = (status: ProviderCredentialStatus): void => {
    setCredentialStatuses((current) => [
      ...current.filter((item) => item.provider !== status.provider),
      status,
    ]);
  };

  const saveCredential = async (provider: Provider): Promise<void> => {
    setBusyProvider(provider);
    setCredentialError(null);
    try {
      const status = await window.desktop.credentials.set({
        provider,
        apiKey: credentialValues[provider],
      });
      updateCredentialStatus(status);
      setCredentialValues((current) => ({ ...current, [provider]: "" }));
    } catch {
      setCredentialError(`${PROVIDER_LABELS[provider]} API key could not be saved.`);
    } finally {
      setBusyProvider(null);
    }
  };

  const deleteCredential = async (provider: Provider): Promise<void> => {
    setBusyProvider(provider);
    setCredentialError(null);
    try {
      updateCredentialStatus(
        await window.desktop.credentials.delete({ provider }),
      );
      setCredentialValues((current) => ({ ...current, [provider]: "" }));
    } catch {
      setCredentialError(
        `${PROVIDER_LABELS[provider]} API key could not be deleted.`,
      );
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-background">
      <header className="flex h-12 items-center px-5 [-webkit-app-region:drag]">
        <span className="text-sm font-medium">Settings</span>
      </header>

      <div className="mx-auto w-full max-w-2xl px-8 pb-16 pt-10">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            General
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">Appearance</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Choose how Desktop Agent looks on this Mac.
          </p>
        </div>

        <Separator className="my-8" />

        <section aria-labelledby="theme-label" className="flex items-start justify-between gap-8">
          <div>
            <h2 id="theme-label" className="text-sm font-medium">
              Theme
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Follow macOS or keep one appearance.
            </p>
          </div>
          <ToggleGroup
            type="single"
            value={theme}
            disabled={saving}
            aria-label="Theme preference"
            onValueChange={(value) => {
              if (value) onThemeChange(value as ThemePreference);
            }}
          >
            <ToggleGroupItem value="system" aria-label="System theme">
              <Laptop />
              System
            </ToggleGroupItem>
            <ToggleGroupItem value="light" aria-label="Light theme">
              <Sun />
              Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" aria-label="Dark theme">
              <Moon />
              Dark
            </ToggleGroupItem>
          </ToggleGroup>
        </section>

        <Separator className="my-8" />

        <section className="flex items-start justify-between gap-8">
          <div>
            <h2 className="text-sm font-medium">Window</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Size and maximized state restore automatically.
            </p>
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            Automatic
          </span>
        </section>

        <Separator className="my-8" />

        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.015em]">
            <KeyRound className="size-4" aria-hidden="true" />
            Provider API keys
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Keys are encrypted using the macOS Keychain. Saved values are never
            shown again.
          </p>
        </div>

        <div className="mt-6 divide-y divide-border rounded-lg border border-border">
          {PROVIDERS.map((provider) => {
            const label = PROVIDER_LABELS[provider];
            const status = credentialStatuses.find(
              (item) => item.provider === provider,
            );
            const configured = status?.configured === true;
            const busy = busyProvider === provider;
            const statusLabel = credentialsLoading
              ? "Checking…"
              : status === undefined
                ? "Unavailable"
                : configured
                  ? "Configured"
                  : "Not configured";

            return (
              <form
                key={provider}
                aria-label={`${label} credentials`}
                className="p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCredential(provider);
                }}
              >
                <div className="flex items-center justify-between gap-4">
                  <label
                    htmlFor={`${provider}-api-key`}
                    className="text-sm font-medium"
                  >
                    {label}
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {statusLabel}
                  </span>
                </div>
                <div className="mt-3 flex gap-2">
                  <input
                    id={`${provider}-api-key`}
                    type="password"
                    autoComplete="off"
                    value={credentialValues[provider]}
                    disabled={credentialsLoading || busy}
                    placeholder={
                      configured ? "Enter a replacement key" : "Enter API key"
                    }
                    className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50"
                    onChange={(event) =>
                      setCredentialValues((current) => ({
                        ...current,
                        [provider]: event.target.value,
                      }))
                    }
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      credentialsLoading ||
                      busy ||
                      credentialValues[provider].trim().length === 0
                    }
                  >
                    {configured ? "Replace" : "Save"}
                  </Button>
                  {configured && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void deleteCredential(provider)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </form>
            );
          })}
        </div>

        {credentialError && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {credentialError}
          </p>
        )}

        {saving && <p className="mt-6 text-xs text-muted-foreground">Saving…</p>}
        {error && (
          <p role="alert" className="mt-6 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
