import { exists, fs, mkdirp } from "./git";

const BOOKS_DIR = "books";

/**
 * Maps an arbitrary book ID to `books/{id}.md`. The ID is percent-encoded so any
 * string is a single, portable file name: `/` and `\` cannot create
 * subdirectories, and characters invalid on Windows checkouts are escaped.
 */
export function bookPath(id: string): string {
  if (!id) throw new Error("Book ID must not be empty.");
  return `${BOOKS_DIR}/${encodeURIComponent(id).replace(/\*/g, "%2A")}.md`;
}

function bookId(fileName: string): string | null {
  if (!fileName.endsWith(".md")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -".md".length));
  } catch {
    return null;
  }
}

/**
 * The book API formerly served over REST; each method maps to the previous endpoint.
 * Implementations decide where books live.
 */
export interface BookApi {
  /** Former `GET /books`: IDs of all books. */
  listBooks(): Promise<string[]>;
  /** Former `GET /books/{id}`: the book's Markdown, or null when not found (404). */
  readBook(id: string): Promise<string | null>;
  /** Former `PUT /books/{id}`: creates or replaces the book. */
  writeBook(id: string, content: string): Promise<void>;
}

/**
 * Book storage over the repository's working tree. Reads and writes are local
 * file-system operations only; `flush` in git.ts commits and pushes them to
 * the remote `main` branch.
 */
export class BookStore implements BookApi {
  constructor(private readonly dir: string) {}

  /** Returns the book's Markdown, or null if no such book exists. */
  async readBook(id: string): Promise<string | null> {
    const path = `${this.dir}/${bookPath(id)}`;
    if (!(await exists(path))) return null;
    return (await fs.promises.readFile(path, { encoding: "utf8" })) as string;
  }

  /** Creates or replaces the book's Markdown in the local working tree. */
  async writeBook(id: string, content: string): Promise<void> {
    const path = `${this.dir}/${bookPath(id)}`;
    await mkdirp(`${this.dir}/${BOOKS_DIR}`);
    await fs.promises.writeFile(path, content, { encoding: "utf8", mode: 0o644 });
    // LightningFS persists to IndexedDB in the background; wait so a reload cannot lose the edit.
    await fs.promises.flush();
  }

  /** IDs of all books present in the local working tree. */
  async listBooks(): Promise<string[]> {
    const path = `${this.dir}/${BOOKS_DIR}`;
    if (!(await exists(path))) return [];
    return (await fs.promises.readdir(path))
      .map(bookId)
      .filter((id): id is string => id !== null)
      .sort();
  }
}
