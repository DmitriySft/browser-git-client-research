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
import { BookStore, bookPath } from "./books";
import {
  BRANCH,
  cloneOrPull,
  hasLocalClone,
  repoDir,
  commitAndPushDemoChange,
  flush,
  headCommit,
  listFiles,
  pendingChanges,
  readFile,
} from "./git";

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
  <section>
    <h2>Books</h2>
    <p>
      Books are stored as <code>books/{id}.md</code> in the browser's local working tree.
      Open, Save, and List use only this local copy, which survives browser restarts.
      Pull fetches remote changes; Flush commits all local changes and pushes them to <code>${BRANCH}</code>.
    </p>
    <input id="book-id" size="40" placeholder="Book ID (any text)" />
    <button id="book-open">Open</button>
    <button id="book-save">Save</button>
    <button id="book-list">List books</button>
    <button id="book-pull">Pull books from GitHub</button>
    <button id="flush">Flush to GitHub</button>
    <p id="storage"></p>
    <p id="book-path"></p>
    <textarea id="book-content" rows="12" cols="80" placeholder="# Book title"></textarea>
    <h3>Local books</h3>
    <ul id="books"></ul>
    <h3>Pending changes</h3>
    <ul id="pending"></ul>
  </section>
  <h2>Log</h2>
  <pre id="log"></pre>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const repoUrl = $<HTMLInputElement>("repo-url");
const log = $<HTMLPreElement>("log");
const bookId = $<HTMLInputElement>("book-id");
const bookContent = $<HTMLTextAreaElement>("book-content");
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

function author(): { name: string; email: string } {
  if (!user) throw new ReauthenticationRequired("Not signed in");
  return { name: user.name || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

/** Local clone only: book operations never touch the network. */
async function localRepository(): Promise<string> {
  const url = repoUrl.value.trim();
  if (!(await hasLocalClone(url))) throw new Error("No local copy yet. Use Pull books to fetch the repository once.");
  dir = repoDir(url);
  return dir;
}

const listItem = (text: string) => Object.assign(document.createElement("li"), { textContent: text });

async function showBooks(): Promise<void> {
  if (!dir) return;
  const books = await new BookStore(dir).listBooks();
  $("books").replaceChildren(
    ...books.map((id) => {
      const item = document.createElement("li");
      const open = Object.assign(document.createElement("button"), { textContent: id });
      open.addEventListener("click", () => {
        bookId.value = id;
        void run(`Open book "${id}"`, () => openBook(id));
      });
      item.append(open);
      return item;
    }),
  );
  const changes = await pendingChanges(dir);
  $("pending").replaceChildren(
    ...(changes.length
      ? changes.map(({ filepath, change }) => listItem(`${change}: ${filepath}`))
      : [listItem("No local changes")]),
  );
}

async function openBook(id: string): Promise<void> {
  const content = await new BookStore(await localRepository()).readBook(id);
  bookContent.value = content ?? "";
  $("book-path").textContent = `${bookPath(id)}${content === null ? " (new; Save creates it)" : ""}`;
}

async function showRepository(): Promise<void> {
  if (!dir) return;
  await showBooks();
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
    const oid = await commitAndPushDemoChange(dir, author());
    write(`Pushed ${oid.slice(0, 7)}`);
    await showRepository();
  }),
);
$("book-open").addEventListener("click", () => run(`Open book "${bookId.value}"`, () => openBook(bookId.value)));
$("book-save").addEventListener("click", () =>
  run(`Save book "${bookId.value}"`, async () => {
    await new BookStore(await localRepository()).writeBook(bookId.value, bookContent.value);
    $("book-path").textContent = bookPath(bookId.value);
    await showBooks();
  }),
);
$("book-list").addEventListener("click", () =>
  run("List books", async () => {
    const books = await new BookStore(await localRepository()).listBooks();
    write(books.length ? `Books: ${books.join(", ")}` : "No books yet");
    await showBooks();
  }),
);
$("book-pull").addEventListener("click", () =>
  run("Pull books", async () => {
    localStorage.setItem("bgit.demo.repoUrl", repoUrl.value);
    const pending = (await hasLocalClone(repoUrl.value.trim())) ? await pendingChanges(await localRepository()) : [];
    if (pending.length) throw new Error("Local changes are not flushed yet. Flush first, which also merges remote changes.");
    dir = await cloneOrPull(repoUrl.value.trim(), write);
    await showRepository();
  }),
);
$("flush").addEventListener("click", () =>
  run("Flush", async () => {
    const result = await flush(await localRepository(), author(), write);
    write(
      result.commit
        ? `Committed ${result.commit.slice(0, 7)} with ${result.changes.length} change(s)` +
            `${result.merged ? " and merged remote changes" : ""}; pushed to ${BRANCH}`
        : `No local changes; ${BRANCH} is pushed`,
    );
    await showRepository();
  }),
);
onTokensChanged(() => void refreshStatus());

/** Reopens the local copy left by an earlier session, without network access. */
async function restoreLocalState(): Promise<void> {
  const persisted = (await navigator.storage?.persist?.()) ?? false;
  const estimate = await navigator.storage?.estimate?.();
  const used = estimate?.usage ? `${(estimate.usage / 1024).toFixed(0)} KB used` : "usage unknown";
  if (await hasLocalClone(repoUrl.value.trim())) {
    dir = repoDir(repoUrl.value.trim());
    await showRepository();
    const books = await new BookStore(dir).listBooks();
    write(`Restored local copy from browser storage: ${books.length} book(s), no network used`);
  }
  $("storage").textContent =
    `Browser storage (IndexedDB "bgit"): ${used}; ` +
    (persisted ? "persistent (protected from eviction)." : "best-effort (the browser may evict it under storage pressure).");
}

void restoreLocalState().catch((error) => write(`Restoring local state failed: ${describe(error)}`));

completeSignIn()
  .then((completed) => completed && write("Sign-in completed"))
  .catch((error) => write(`Sign-in failed: ${describe(error)}`))
  .finally(() => void refreshStatus());
