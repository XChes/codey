import {
  PROVIDERS,
  providerApiKeySchema,
  providerCredentialSetInputSchema,
  type Provider,
  type ProviderCredentialSetInput,
  type ProviderCredentialStatus,
} from "../shared/provider-credentials";
import type { AppStore } from "./app-store";

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class ProviderCredentialStore {
  constructor(
    private readonly appStore: AppStore,
    private readonly safeStorage: SafeStorageAdapter,
  ) {}

  list(): ProviderCredentialStatus[] {
    const configured = new Set(
      this.appStore.listEncryptedProviderCredentialProviders(),
    );
    return PROVIDERS.map((provider) => ({
      provider,
      configured: configured.has(provider),
    }));
  }

  set(input: ProviderCredentialSetInput): ProviderCredentialStatus {
    this.requireEncryption();
    const value = providerCredentialSetInputSchema.parse(input);
    const encrypted = this.safeStorage.encryptString(value.apiKey);
    if (encrypted.length === 0) {
      throw new Error("Provider credential encryption failed.");
    }
    this.appStore.setEncryptedProviderCredential(value.provider, encrypted);
    return { provider: value.provider, configured: true };
  }

  delete(provider: Provider): ProviderCredentialStatus {
    this.appStore.deleteEncryptedProviderCredential(provider);
    return { provider, configured: false };
  }

  getApiKeys(): Record<string, string> {
    this.requireEncryption();
    const apiKeys: Record<string, string> = {};
    for (const provider of PROVIDERS) {
      const encrypted =
        this.appStore.getEncryptedProviderCredential(provider);
      if (encrypted === undefined) continue;
      apiKeys[provider] = providerApiKeySchema.parse(
        this.safeStorage.decryptString(encrypted),
      );
    }
    return apiKeys;
  }

  private requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable.");
    }
  }
}
