import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "2.97.0";
const releases = {
  arm64: {
    asset: `gh_${version}_macOS_arm64.zip`,
    checksum:
      "a58b8fd77b417a38f47a0b54d1370c59b0fcdb324ccc9ca002b0998f7c4c999e",
    directory: `gh_${version}_macOS_arm64`,
  },
  x64: {
    asset: `gh_${version}_macOS_amd64.zip`,
    checksum:
      "63298c998cc2a924c9e254c6af6a1caad6ece281122687a91f079bc0a462700e",
    directory: `gh_${version}_macOS_amd64`,
  },
};

const architecture = process.argv[2] ?? process.arch;
const release = releases[architecture];
if (release === undefined) {
  throw new Error(`Unsupported GitHub CLI architecture: ${architecture}`);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = join(repositoryRoot, "resources", "gh");
const downloadDirectory = join(resourceRoot, "downloads");
const archivePath = join(downloadDirectory, release.asset);
const targetDirectory = join(resourceRoot, architecture);
const targetBinary = join(targetDirectory, "gh");
const downloadUrl = `https://github.com/cli/cli/releases/download/v${version}/${release.asset}`;

function checksum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function downloadArchive() {
  mkdirSync(downloadDirectory, { recursive: true });
  if (existsSync(archivePath) && checksum(archivePath) === release.checksum) {
    return;
  }

  rmSync(archivePath, { force: true });
  execFileSync("/usr/bin/curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--output",
    archivePath,
    downloadUrl,
  ]);
  const actualChecksum = checksum(archivePath);
  if (actualChecksum !== release.checksum) {
    rmSync(archivePath, { force: true });
    throw new Error(
      `GitHub CLI checksum mismatch: expected ${release.checksum}, received ${actualChecksum}`,
    );
  }
}

downloadArchive();

const extractionDirectory = mkdtempSync(join(tmpdir(), "codey-gh-"));
try {
  execFileSync("/usr/bin/ditto", [
    "-x",
    "-k",
    archivePath,
    extractionDirectory,
  ]);
  const extractedBinary = join(
    extractionDirectory,
    release.directory,
    "bin",
    "gh",
  );
  if (!existsSync(extractedBinary)) {
    throw new Error(`GitHub CLI archive did not contain ${release.directory}/bin/gh`);
  }

  rmSync(targetDirectory, { recursive: true, force: true });
  mkdirSync(targetDirectory, { recursive: true });
  copyFileSync(extractedBinary, targetBinary);
  chmodSync(targetBinary, 0o755);
  execFileSync(targetBinary, ["--version"], { stdio: "inherit" });
} finally {
  rmSync(extractionDirectory, { recursive: true, force: true });
}

console.log(`Prepared GitHub CLI ${version} for macOS ${architecture}.`);
