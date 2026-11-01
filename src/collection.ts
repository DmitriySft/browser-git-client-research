import { exists, fs, mkdirp } from "./git";

/** Converts an entity to and from file text. Must be deterministic so Git diffs and merges stay small. */
export interface Codec<T> {
  extension: string;
  encode(value: T): string;
  decode(text: string): T;
}

/** Plain text files, for example Markdown documents. */
export const textCodec = (extension: string): Codec<string> => ({
  extension,
  encode: (value) => value,
  decode: (text) => text,
});

/** JSON DTOs with sorted keys, 2-space indentation, and a trailing newline. */
export const jsonCodec = <T>(): Codec<T> => ({
  extension: ".json",
  encode: (value) => `${JSON.stringify(sortKeys(value), null, 2)}\n`,
  decode: (text) => JSON.parse(text) as T,
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** Generic CRUD contract that replaces a REST resource (`/{collection}` and `/{collection}/{id}`). */
export interface CrudApi<T> {
  /** Former `GET /{collection}`. */
  list(): Promise<string[]>;
  /** Former `GET /{collection}/{id}`; null replaces 404. */
  read(id: string): Promise<T | null>;
  /** Former `POST /{collection}` and `PUT /{collection}/{id}`. */
  write(id: string, value: T): Promise<void>;
  /** Former `DELETE /{collection}/{id}`; returns false when it did not exist. */
  delete(id: string): Promise<boolean>;
}

/**
 * Stores one entity type as `{folder}/{encoded id}{extension}` in the local
 * working tree. Every method is local only; `flush` in git.ts publishes changes.
 */
export class GitCollection<T> implements CrudApi<T> {
  constructor(
    private readonly dir: string,
    readonly folder: string,
    private readonly codec: Codec<T>,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(folder)) throw new Error(`Invalid collection folder "${folder}".`);
  }

  /**
   * Repository-relative path of an entity. The ID is percent-encoded so any
   * string is one portable file name: `/` and `\` cannot create subdirectories,
   * and characters invalid on Windows checkouts are escaped.
   */
  path(id: string): string {
    if (!id) throw new Error("ID must not be empty.");
    return `${this.folder}/${encodeURIComponent(id).replace(/\*/g, "%2A")}${this.codec.extension}`;
  }

  async list(): Promise<string[]> {
    const folder = `${this.dir}/${this.folder}`;
    if (!(await exists(folder))) return [];
    return (await fs.promises.readdir(folder))
      .map((name) => this.idFromFileName(name))
      .filter((id): id is string => id !== null)
      .sort();
  }

  async read(id: string): Promise<T | null> {
    const file = `${this.dir}/${this.path(id)}`;
    if (!(await exists(file))) return null;
    return this.codec.decode((await fs.promises.readFile(file, { encoding: "utf8" })) as string);
  }

  async write(id: string, value: T): Promise<void> {
    await mkdirp(`${this.dir}/${this.folder}`);
    await fs.promises.writeFile(`${this.dir}/${this.path(id)}`, this.codec.encode(value), {
      encoding: "utf8",
      mode: 0o644,
    });
    // LightningFS persists to IndexedDB in the background; wait so a reload cannot lose the edit.
    await fs.promises.flush();
  }

  async delete(id: string): Promise<boolean> {
    const file = `${this.dir}/${this.path(id)}`;
    if (!(await exists(file))) return false;
    await fs.promises.unlink(file);
    await fs.promises.flush();
    return true;
  }

  private idFromFileName(name: string): string | null {
    if (!name.endsWith(this.codec.extension)) return null;
    try {
      return decodeURIComponent(name.slice(0, -this.codec.extension.length));
    } catch {
      return null;
    }
  }
}
