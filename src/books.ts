import { GitCollection, textCodec } from "./collection";

/**
 * The demo entity. A real app defines one such wrapper (or uses GitCollection
 * directly) per REST resource; see docs/rest-to-git-storage.md.
 */
export interface BookApi {
  /** Former `GET /books`: IDs of all books. */
  listBooks(): Promise<string[]>;
  /** Former `GET /books/{id}`: the book's Markdown, or null when not found (404). */
  readBook(id: string): Promise<string | null>;
  /** Former `PUT /books/{id}`: creates or replaces the book. */
  writeBook(id: string, content: string): Promise<void>;
  /** Former `DELETE /books/{id}`: false when the book did not exist. */
  deleteBook(id: string): Promise<boolean>;
}

/** Books stored as `books/{id}.md` in the local working tree. */
export class BookStore implements BookApi {
  private readonly books: GitCollection<string>;

  constructor(dir: string) {
    this.books = new GitCollection(dir, "books", textCodec(".md"));
  }

  path(id: string): string {
    return this.books.path(id);
  }

  listBooks(): Promise<string[]> {
    return this.books.list();
  }

  readBook(id: string): Promise<string | null> {
    return this.books.read(id);
  }

  writeBook(id: string, content: string): Promise<void> {
    return this.books.write(id, content);
  }

  deleteBook(id: string): Promise<boolean> {
    return this.books.delete(id);
  }
}
