import "./polyfills";
import {
  completeSignIn,
  getAccessToken,
  loadTokens,
  onTokensChanged,
  ReauthenticationRequired,
  recoverFromRejectedToken,
  signIn,
  signOut,
} from "./auth";
import { config } from "./config";
import { cloneOrPull, commitAndPushDemoChange, headCommit, listFiles, readFile } from "./git";

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app element not found");

app.innerHTML = `
  <h1>Browser Git client</h1>
  <section>
    <h2>Sign-in</h2>
    <p id="status">Checking sign-in…</p>
    <button id="sign-in">Sign in with GitHub</button>
    <button id="sign-out">Sign out</button>
  </section>
  <section>
    <h2>Repository</h2>
    <input id="repo-url" size="60" placeholder="https://github.com/owner/repository.git" />
    <button id="clone">Clone / pull</button>
    <button id="readme">Read README.md</button>
    <button id="push">Commit &amp; push test change</button>
    <p id="head"></p>
    <ul id="files"></ul>
    <h3>README.md</h3>
    <pre id="readme-content"></pre>
  </section>
  <h2>Log</h2>
  <pre id="log"></pre>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const repoUrl = $<HTMLInputElement>("repo-url");
const log = $<HTMLPreElement>("log");
let user: GitHubUser | null = null;
let dir: string | null = null;

repoUrl.value = localStorage.getItem("bgit.demo.repoUrl") || config.demoRepoUrl;

function write(message: string): void {
  log.textContent = `${new Date().toLocaleTimeString()} ${message}\n${log.textContent}`;
}

function describe(error: unknown): string {
  if (error instanceof ReauthenticationRequired) return `${error.message}. Please sign in again.`;
  return error instanceof Error ? error.message : String(error);
}

/** api.github.com allows CORS, so it is called directly rather than through the proxy. */
async function fetchUser(): Promise<GitHubUser> {
  let token = await getAccessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      credentials: "omit",
    });
    if (response.ok) return response.json();
    if (response.status !== 401) throw new Error(`GitHub API returned HTTP ${response.status}`);
    const next = await recoverFromRejectedToken(token);
    if (!next) break;
    token = next;
  }
  throw new ReauthenticationRequired("GitHub rejected the stored token");
}

async function refreshStatus(): Promise<void> {
  const tokens = loadTokens();
  $("sign-in").hidden = !!tokens;
  $("sign-out").hidden = !tokens;
  if (!tokens) {
    user = null;
    status.textContent = "Not signed in.";
    return;
  }
  try {
    user = await fetchUser();
    const expiry = loadTokens()?.expiresAt;
    status.textContent = `Signed in as ${user.login}${
      expiry ? `; access token expires ${new Date(expiry).toLocaleTimeString()}` : "; token does not expire"
    }.`;
  } catch (error) {
    status.textContent = describe(error);
  }
}

async function run(label: string, action: () => Promise<void>): Promise<void> {
  document.querySelectorAll("button").forEach((button) => (button.disabled = true));
  write(`${label}…`);
  try {
    await action();
    write(`${label}: done`);
  } catch (error) {
    write(`${label} failed: ${describe(error)}`);
    console.error(error);
  } finally {
    document.querySelectorAll("button").forEach((button) => (button.disabled = false));
  }
}

async function showRepository(): Promise<void> {
  if (!dir) return;
  $("head").textContent = `HEAD: ${await headCommit(dir)}`;
  const files = $<HTMLUListElement>("files");
  files.replaceChildren(
    ...(await listFiles(dir)).map((file) => Object.assign(document.createElement("li"), { textContent: file })),
  );
}

$("sign-in").addEventListener("click", () => run("Sign-in", signIn));
$("sign-out").addEventListener("click", () => signOut());
$("clone").addEventListener("click", () =>
  run("Clone / pull", async () => {
    localStorage.setItem("bgit.demo.repoUrl", repoUrl.value);
    dir = await cloneOrPull(repoUrl.value.trim(), write);
    await showRepository();
  }),
);
$("readme").addEventListener("click", () =>
  run("Read README.md", async () => {
    localStorage.setItem("bgit.demo.repoUrl", repoUrl.value);
    dir = await cloneOrPull(repoUrl.value.trim(), write);
    await showRepository();
    $("readme-content").textContent = await readFile(dir, "README.md");
  }),
);
$("push").addEventListener("click", () =>
  run("Commit & push", async () => {
    if (!dir) throw new Error("Clone the repository first.");
    if (!user) throw new ReauthenticationRequired("Not signed in");
    const oid = await commitAndPushDemoChange(dir, {
      name: user.name || user.login,
      email: `${user.id}+${user.login}@users.noreply.github.com`,
    });
    write(`Pushed ${oid.slice(0, 7)}`);
    await showRepository();
  }),
);
onTokensChanged(() => void refreshStatus());

completeSignIn()
  .then((completed) => completed && write("Sign-in completed"))
  .catch((error) => write(`Sign-in failed: ${describe(error)}`))
  .finally(() => void refreshStatus());
