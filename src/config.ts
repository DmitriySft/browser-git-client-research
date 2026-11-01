const env = import.meta.env;

/** Public client ID of the registered GitHub OAuth App or GitHub App. */
const oauthClientId = env.VITE_OAUTH_CLIENT_ID || "Ov23liYk4IDSqiJp0v9W";

export const config = {
  /** Customer proxy base URL; Git and token requests go through it. */
  proxyUrl: (env.VITE_PROXY_URL ||
    "https://git-proxy-wpnzxfaym7kcs.gentlepond-06cb06de.newzealandnorth.azurecontainerapps.io").replace(/\/$/, ""),
  /** Name of the proxy's oauthClients entry. */
  oauthClient: env.VITE_OAUTH_CLIENT || "github",
  oauthClientId,
  authorizeUrl: env.VITE_OAUTH_AUTHORIZE_URL || "https://github.com/login/oauth/authorize",
  /**
   * GitHub Apps (client IDs starting with "Iv") ignore scopes and are limited to the repositories
   * they are installed on. OAuth Apps ("Ov") need "repo", which grants every repository of the user.
   */
  scope: env.VITE_OAUTH_SCOPE ?? (oauthClientId.startsWith("Ov") ? "repo" : ""),
  redirectUri: `${location.origin}/oauth/callback`,
  demoRepoUrl: env.VITE_DEMO_REPO_URL || "https://github.com/DmitriySft/browser-git-demo-repo.git",
};
