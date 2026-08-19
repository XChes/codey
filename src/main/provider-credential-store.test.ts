// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

import { AppStore } from "./app-store";
import {
  ProviderCredentialStore,
  type SafeStorageAdapter,
} from "./provider-credential-store";

const temporaryDirectories: string[] = [];

function createAppStore(): AppStore {
  const directory = mkdtempSync(join(tmpdir(), "provider-credentials-"));
  temporaryDirectories.push(directory);
  return new AppStore(join(directory, "app.sqlite"));
}

function safeStorage(available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    ),
    decryptString: vi.fn((value: Buffer) =>
      Buffer.from(
        value.toString().replace(/^encrypted:/, ""),
        "base64",
      ).toString(),
    ),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderCredentialStore", () => {
  it("persists only encrypted blobs and returns configured status", () => {
    const appStore = createAppStore();
    const encryption = safeStorage();
    const credentials = new ProviderCredentialStore(appStore, encryption);

    expect(credentials.list()).toEqual([
      { provider: "deepseek", configured: false },
      { provider: "openai", configured: false },
      { provider: "xai", configured: false },
    ]);

    expect(
      credentials.set({ provider: "openai", apiKey: "  sk-secret  " }),
    ).toEqual({ provider: "openai", configured: true });
    expect(
      appStore.getEncryptedProviderCredential("openai")?.toString(),
    ).toBe("encrypted:c2stc2VjcmV0");
    expect(appStore.getEncryptedProviderCredential("openai")?.toString()).not.toContain(
      "sk-secret",
    );
    expect(credentials.getApiKeys()).toEqual({ openai: "sk-secret" });
    expect(credentials.list()).toContainEqual({
      provider: "openai",
      configured: true,
    });

    expect(credentials.delete("openai")).toEqual({
      provider: "openai",
      configured: false,
    });
    expect(credentials.getApiKeys()).toEqual({});
    appStore.close();
  });

  it("does not store or read keys when encryption is unavailable", () => {
    const appStore = createAppStore();
    const credentials = new ProviderCredentialStore(
      appStore,
      safeStorage(false),
    );

    expect(() =>
      credentials.set({ provider: "xai", apiKey: "xai-secret" }),
    ).toThrow("Secure credential storage is unavailable.");
    expect(() => credentials.getApiKeys()).toThrow(
      "Secure credential storage is unavailable.",
    );
    expect(appStore.listEncryptedProviderCredentialProviders()).toEqual([]);
    appStore.close();
  });

  it("decrypts an encrypted key after the application store reopens", () => {
    const directory = mkdtempSync(join(tmpdir(), "provider-credentials-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "app.sqlite");
    const encryption = safeStorage();
    const first = new AppStore(path);
    new ProviderCredentialStore(first, encryption).set({
      provider: "deepseek",
      apiKey: "deepseek-secret",
    });
    first.close();

    const second = new AppStore(path);
    const credentials = new ProviderCredentialStore(second, encryption);
    expect(credentials.list()).toContainEqual({
      provider: "deepseek",
      configured: true,
    });
    expect(credentials.getApiKeys()).toEqual({
      deepseek: "deepseek-secret",
    });
    second.close();
  });
});
