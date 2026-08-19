export const PROVIDER_CREDENTIALS: Record<
  string,
  { environmentKey: string; domains: string[] }
> = {
  deepseek: {
    environmentKey: "DEEPSEEK_API_KEY",
    domains: ["api.deepseek.com"],
  },
  openai: {
    environmentKey: "OPENAI_API_KEY",
    domains: ["api.openai.com"],
  },
  xai: {
    environmentKey: "XAI_API_KEY",
    domains: ["api.x.ai"],
  },
};
