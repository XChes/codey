// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { GitHubService } from "./github-service";

describe("GitHubService", () => {
  it("lists repositories available to the authenticated account", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce("github.com\n")
      .mockResolvedValueOnce(
        JSON.stringify([
          [
            {
              full_name: "octo/private-repo",
              name: "private-repo",
              description: "Private work",
              private: true,
            },
            {
              full_name: "octo/public-repo",
              name: "public-repo",
              description: null,
              private: false,
            },
          ],
        ]),
      );

    await expect(new GitHubService(run).listRepositories()).resolves.toEqual([
      {
        nameWithOwner: "octo/private-repo",
        name: "private-repo",
        description: "Private work",
        isPrivate: true,
      },
      {
        nameWithOwner: "octo/public-repo",
        name: "public-repo",
        description: null,
        isPrivate: false,
      },
    ]);
    expect(run).toHaveBeenNthCalledWith(1, ["auth", "status"]);
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["api", "user/repos", "--paginate", "--slurp"]),
    );
  });

  it("reports missing authentication without querying repositories", async () => {
    const run = vi.fn().mockRejectedValue(new Error("not logged in"));

    await expect(new GitHubService(run).listRepositories()).rejects.toThrow(
      "Run `gh auth login`",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("preserves the missing CLI error", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new Error("GitHub CLI (gh) is not installed."));

    await expect(new GitHubService(run).listRepositories()).rejects.toThrow(
      "GitHub CLI (gh) is not installed",
    );
  });

  it("reports a missing bundled executable as a damaged installation", async () => {
    const service = new GitHubService(
      undefined,
      "/definitely/missing/codey-bundled-gh",
    );

    await expect(service.listRepositories()).rejects.toThrow(
      "bundled GitHub CLI is missing or damaged",
    );
  });

  it("clones with argument-safe repository and destination values", async () => {
    const run = vi.fn().mockResolvedValue("");
    const service = new GitHubService(run);

    await service.cloneRepository(
      "octo/repository",
      "/Users/test/My Projects/repository",
    );

    expect(run).toHaveBeenNthCalledWith(1, ["auth", "status"]);
    expect(run).toHaveBeenNthCalledWith(2, [
      "repo",
      "clone",
      "octo/repository",
      "/Users/test/My Projects/repository",
    ]);
  });
});
