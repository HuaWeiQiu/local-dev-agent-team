import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";

/** The handle an exclusive create returns: enough to publish a complete record. */
export interface LeaseFileHandle {
  write(text: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The file operations the lease needs, behind one seam.
 *
 * The seam exists so an acquisition can be driven step by step in a test: the
 * only way to prove a mutual-exclusion claim is to interleave two claimaints at
 * the exact await where the old implementation lost, and that cannot be done
 * through `node:fs/promises` itself.
 */
export interface LeaseFileSystem {
  mkdir(directory: string): Promise<void>;
  /** Create and open a file that must not exist yet (`O_CREAT|O_EXCL`). */
  openExclusive(file: string): Promise<LeaseFileHandle>;
  /** Create `to` as a second name for `from`; fails when `to` already exists. */
  link(from: string, to: string): Promise<void>;
  /** The file's text, or undefined when it does not exist. */
  read(file: string): Promise<string | undefined>;
  unlink(file: string): Promise<void>;
  /** Age of a file, used to judge whether a marker was abandoned. */
  modifiedAt(file: string): Promise<number | undefined>;
}

export const nodeLeaseFileSystem: LeaseFileSystem = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  async openExclusive(file) {
    const handle = await open(file, "wx", 0o600);
    return {
      async write(text) {
        await handle.writeFile(text, "utf8");
      },
      async sync() {
        await handle.sync();
      },
      async close() {
        await handle.close();
      },
    };
  },
  async link(from, to) {
    await link(from, to);
  },
  async read(file) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  },
  async unlink(file) {
    await unlink(file);
  },
  async modifiedAt(file) {
    try {
      return (await stat(file)).mtimeMs;
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  },
};

export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
