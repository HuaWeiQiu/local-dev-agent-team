import { describe, expect, it } from "vitest";
import { parseGitRemoteOwner, remoteOwnerAllowed } from "../src/git/remote-policy.js";

describe("remote owner policy", () => {
  it("parses HTTPS and SSH GitHub remotes", () => {
    expect(parseGitRemoteOwner("https://github.com/acme/app.git")).toEqual({
      host: "github.com",
      owner: "acme",
    });
    expect(parseGitRemoteOwner("git@github.com:acme/app.git")).toEqual({
      host: "github.com",
      owner: "acme",
    });
  });

  it("allows any remote when the allowlist is empty", () => {
    expect(remoteOwnerAllowed("https://github.com/other/app.git", []).allowed).toBe(true);
  });

  it("rejects remotes outside the company allowlist", () => {
    const result = remoteOwnerAllowed("https://github.com/random/app.git", ["acme"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("acme");
  });

  it("accepts an allowlisted owner", () => {
    expect(remoteOwnerAllowed("git@github.com:acme/app.git", ["acme", "acme-labs"]).allowed).toBe(true);
  });
});
