import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSessionToken,
  SESSION_TOKEN_ENV,
  SESSION_TOKEN_FILE_ENV,
} from "../src/server/session-token.js";

describe("resolveSessionToken", () => {
  let directory: string;
  let tokenFile: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-team-token-file-"));
    tokenFile = path.join(directory, "session-token");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeTokenFile(contents: string, mode = 0o600): Promise<void> {
    await writeFile(tokenFile, contents, { mode: 0o600 });
    await chmod(tokenFile, mode);
  }

  it("prefers the token file over the direct environment variable", async () => {
    await writeTokenFile("file-token\n");
    const token = await resolveSessionToken({
      [SESSION_TOKEN_FILE_ENV]: tokenFile,
      [SESSION_TOKEN_ENV]: "env-token",
    });
    expect(token).toBe("file-token");
  });

  it("falls back to the direct environment variable without a token file", async () => {
    const token = await resolveSessionToken({ [SESSION_TOKEN_ENV]: "env-token" });
    expect(token).toBe("env-token");
  });

  it("generates a random token when neither source is configured", async () => {
    const first = await resolveSessionToken({});
    const second = await resolveSessionToken({});
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it("refuses to start when the token file is missing", async () => {
    await expect(
      resolveSessionToken({ [SESSION_TOKEN_FILE_ENV]: tokenFile }),
    ).rejects.toThrow(`Cannot read session token file '${tokenFile}'`);
  });

  it("refuses to start when the token file is empty", async () => {
    await writeTokenFile("  \n");
    await expect(
      resolveSessionToken({ [SESSION_TOKEN_FILE_ENV]: tokenFile }),
    ).rejects.toThrow(`Session token file '${tokenFile}' is empty`);
  });

  it.skipIf(process.platform === "win32")(
    "refuses to start when the token file is readable by others",
    async () => {
      await writeTokenFile("file-token", 0o644);
      await expect(
        resolveSessionToken({ [SESSION_TOKEN_FILE_ENV]: tokenFile }),
      ).rejects.toThrow(`must have mode 0600 (found 0644)`);
    },
  );
});
