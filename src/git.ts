import LightningFS from "@isomorphic-git/lightning-fs";
import git, { type AuthCallback, type AuthFailureCallback } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { getAccessToken, recoverFromRejectedToken } from "./auth";
import { config } from "./config";

/** Browser-private IndexedDB file system; a placeholder pending storage research. */
const fs = new LightningFS("bgit");

const onAuth: AuthCallback = async () => ({ username: "x-access-token", password: await getAccessToken() });

const onAuthFailure: AuthFailureCallback = async (_url, auth) => {
  const token = auth.password ? await recoverFromRejectedToken(auth.password) : null;
  return token && token !== auth.password ? { username: "x-access-token", password: token } : { cancel: true };
};

const remote = { fs, http, corsProxy: config.proxyUrl, onAuth, onAuthFailure };

export function repoDir(url: string): string {
  const { host, pathname } = new URL(url);
  return `/${host}${pathname.replace(/\.git$/, "")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function mkdirp(path: string): Promise<void> {
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    if (!(await exists(current))) await fs.promises.mkdir(current);
  }
}

/** Clones the repository, or fast-forwards an existing local clone. */
export async function cloneOrPull(url: string, onMessage: (message: string) => void): Promise<string> {
  const dir = repoDir(url);
  const onProgress = ({ phase, loaded, total }: { phase: string; loaded: number; total?: number }) =>
    onMessage(`${phase}: ${loaded}${total ? `/${total}` : ""}`);
  if (await exists(`${dir}/.git`)) {
    await git.fastForward({ ...remote, dir, singleBranch: true, onProgress });
  } else {
    await mkdirp(dir);
    await git.clone({ ...remote, dir, url, singleBranch: true, onProgress });
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
  const result = await git.push({ ...remote, dir });
  if (!result.ok) throw new Error(`Push rejected: ${result.error ?? JSON.stringify(result.refs)}`);
  return oid;
}
