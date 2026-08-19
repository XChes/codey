import { execFile } from "node:child_process";
import { z } from "zod";

import {
  githubRepositorySchema,
  type GitHubRepository,
} from "../shared/workspace";

export type GitHubCommandRunner = (args: string[]) => Promise<string>;

const apiRepositorySchema = z
  .object({
    full_name: z.string().min(3),
    name: z.string().min(1),
    description: z.string().nullable(),
    private: z.boolean(),
  })
  .passthrough();

const apiPagesSchema = z.array(z.array(apiRepositorySchema));

function runGitHubCommand(
  executable: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new Error(
                executable === "gh"
                  ? "GitHub CLI (gh) is not installed."
                  : "The bundled GitHub CLI is missing or damaged.",
              ),
            );
            return;
          }
          reject(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                `GitHub CLI command failed: gh ${args.join(" ")}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class GitHubService {
  private readonly run: GitHubCommandRunner;

  constructor(run?: GitHubCommandRunner, executable = "gh") {
    this.run = run ?? ((args) => runGitHubCommand(executable, args));
  }

  private async requireAuthentication(): Promise<void> {
    try {
      await this.run(["auth", "status"]);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "GitHub CLI (gh) is not installed." ||
          error.message === "The bundled GitHub CLI is missing or damaged.")
      ) {
        throw error;
      }
      throw new Error(
        "GitHub CLI is not authenticated. Run `gh auth login` and try again.",
      );
    }
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    await this.requireAuthentication();
    const output = await this.run([
      "api",
      "--method",
      "GET",
      "user/repos",
      "--paginate",
      "--slurp",
      "-f",
      "per_page=100",
      "-f",
      "sort=pushed",
      "-f",
      "affiliation=owner,collaborator,organization_member",
    ]);

    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw new Error("GitHub CLI returned an invalid repository list.");
    }
    const pages = apiPagesSchema.safeParse(value);
    if (!pages.success) {
      throw new Error("GitHub CLI returned an invalid repository list.");
    }

    const seen = new Set<string>();
    return pages.data.flatMap((page) =>
      page.flatMap((repository) => {
        if (seen.has(repository.full_name)) return [];
        seen.add(repository.full_name);
        return [
          githubRepositorySchema.parse({
            nameWithOwner: repository.full_name,
            name: repository.name,
            description: repository.description,
            isPrivate: repository.private,
          }),
        ];
      }),
    );
  }

  async cloneRepository(
    nameWithOwner: string,
    destination: string,
  ): Promise<void> {
    await this.requireAuthentication();
    await this.run(["repo", "clone", nameWithOwner, destination]);
  }
}
