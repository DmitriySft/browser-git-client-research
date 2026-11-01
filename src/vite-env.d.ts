/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROXY_URL?: string;
  readonly VITE_OAUTH_CLIENT?: string;
  readonly VITE_OAUTH_CLIENT_ID?: string;
  readonly VITE_OAUTH_AUTHORIZE_URL?: string;
  readonly VITE_OAUTH_SCOPE?: string;
  readonly VITE_DEMO_REPO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
