import LightningFS from "@isomorphic-git/lightning-fs";
import git, { type AuthCallback, type AuthFailureCallback } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { getAccessToken, loadTokens, recoverFromRejectedToken } from "./auth";
import { config } from "./config";

/** Browser-private IndexedDB file system; a placeholder pending storage research. */
export const fs = new LightningFS("bgit");

/** The demo always works on, and pushes to, this branch. */
export const BRANCH = "main";

/** Shared parsed-object cache; avoids re-reading packfiles on every command. */
const cache = {};

const onAuth: AuthCallback = async () => ({ username: "x-access-token", password: await getAccessToken() });

const onAuthFailure: AuthFailureCallback = async (_url, auth) => {
  const token = auth.password ? await recoverFromRejectedToken(auth.password) : null;
  return token && token !== auth.password ? { username: "x-access-token", password: token } : { cancel: true };
};

/**
 * Options for network commands. isomorphic-git otherwise sends its first request without
 * credentials and only calls onAuth after a 401, which costs a round trip and logs a 401
 * in the browser console on every pull or push. When signed in, send the token up front;
 * onAuth/onAuthFailure still handle a rejected or refreshed token.
 */
async function remoteOptions() {
  const headers: Record<string, string> = {};
  if (loadTokens()) headers.Authorization = `Basic ${btoa(`x-access-token:${await getAccessToken()}`)}`;
  return { fs, http, cache, corsProxy: config.proxyUrl, onAuth, onAuthFailure, headers };
}

export function repoDir(url: string): string {
  const { host, pathname } = new URL(url);
  return `/${host}${pathname.replace(/\.git$/, "")}`;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function mkdirp(path: string): Promise<void> {
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    if (!(await exists(current))) await fs.promises.mkdir(current);
  }
}

/** True when the repository was cloned earlier and is available offline in the browser file system. */
export async function hasLocalClone(url: string): Promise<boolean> {
  return exists(`${repoDir(url)}/.git`);
}

/** Clones the repository, or fast-forwards an existing local clone. */
export async function cloneOrPull(url: string, onMessage: (message: string) => void): Promise<string> {
  const dir = repoDir(url);
  const onProgress = ({ phase, loaded, total }: { phase: string; loaded: number; total?: number }) =>
    onMessage(`${phase}: ${loaded}${total ? `/${total}` : ""}`);
  if (await exists(`${dir}/.git`)) {
    await git.fastForward({ ...(await remoteOptions()), dir, ref: BRANCH, singleBranch: true, onProgress });
  } else {
    await mkdirp(dir);
    await git.clone({ ...(await remoteOptions()), dir, url, ref: BRANCH, singleBranch: true, onProgress });
  }
  return dir;
}

export async function listFiles(dir: string): Promise<string[]> {
  return git.listFiles({ fs, dir, ref: "HEAD" });
}

export async function headCommit(dir: string): Promise<string> {
  const [commit] = await git.log({ fs, dir, depth: 1 });
  return `${commit.oid.slice(0, 7)} ${commit.commit.message.split("\n")[0]}`;
}

/** Reads a file from the HEAD commit of the local clone. */
export async function readFile(dir: string, filepath: string): Promise<string> {
  const oid = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const { blob } = await git.readBlob({ fs, dir, oid, filepath });
  return new TextDecoder().decode(blob);
}

/** Appends a line to bgit-hello.md, commits it, and pushes the current branch. */
export async function commitAndPushDemoChange(
  dir: string,
  author: { name: string; email: string },
): Promise<string> {
  const path = "bgit-hello.md";
  const previous = (await exists(`${dir}/${path}`))
    ? ((await fs.promises.readFile(`${dir}/${path}`, { encoding: "utf8" })) as string)
    : "# Browser Git client test log\n\n";
  await fs.promises.writeFile(`${dir}/${path}`, `${previous}- ${new Date().toISOString()} by ${author.name}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await git.add({ fs, dir, filepath: path });
  const oid = await git.commit({ fs, dir, message: `Browser Git client test commit by ${author.name}`, author });
  const result = await git.push({ ...(await remoteOptions()), dir });
  if (!result.ok) throw new Error(`Push rejected: ${result.error ?? JSON.stringify(result.refs)}`);
  return oid;
}

export interface PendingChange {
  filepath: string;
  change: "added" | "modified" | "deleted";
}

/** Working-tree changes relative to HEAD, from isomorphic-git's [head, workdir, stage] matrix. */
export async function pendingChanges(dir: string): Promise<PendingChange[]> {
  const matrix = await git.statusMatrix({ fs, dir, cache });
  return matrix
    .filter(([, head, workdir]) => !(head === 1 && workdir === 1))
    .map(([filepath, head, workdir]) => ({
      filepath,
      change: head === 0 ? "added" : workdir === 0 ? "deleted" : "modified",
    }));
}

export interface FlushResult {
  changes: PendingChange[];
  commit: string | null;
  merged: boolean;
}

/**
 * Commits every working-tree change and pushes it to the remote main branch.
 * If the remote moved ahead, pulls (fetch + merge) once and pushes again;
 * merge conflicts are reported and the local commit is kept.
 */
export async function flush(
  dir: string,
  author: { name: string; email: string },
  onMessage: (message: string) => void,
): Promise<FlushResult> {
  const branch = await git.currentBranch({ fs, dir });
  if (branch !== BRANCH) throw new Error(`Expected branch ${BRANCH}, but HEAD is ${branch ?? "detached"}.`);

  const changes = await pendingChanges(dir);
  for (const { filepath, change } of changes) {
    if (change === "deleted") await git.remove({ fs, dir, filepath, cache });
    else await git.add({ fs, dir, filepath, cache });
  }
  const commit = changes.length
    ? await git.commit({
        fs,
        dir,
        cache,
        author,
        message: `Update ${changes.length} file(s) from browser client\n\n${changes
          .map(({ filepath, change }) => `- ${change}: ${filepath}`)
          .join("\n")}`,
      })
    : null;

  const pushOnce = async () => git.push({ ...(await remoteOptions()), dir, ref: BRANCH, remoteRef: BRANCH });
  let merged = false;
  let result;
  try {
    result = await pushOnce();
  } catch (error) {
    if (!(error instanceof git.Errors.PushRejectedError)) throw error;
    onMessage("Remote has new commits; pulling and merging…");
    await git.pull({ ...(await remoteOptions()), dir, ref: BRANCH, singleBranch: true, author });
    merged = true;
    result = await pushOnce();
  }
  if (!result.ok) throw new Error(`Push rejected: ${result.error ?? JSON.stringify(result.refs)}`);
  return { changes, commit, merged };
}
