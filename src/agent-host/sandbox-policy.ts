import { readdirSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type {
  TaskAccessMode,
  TaskInteractionMode,
} from "../shared/task.js";
import type { AgentCapability } from "../shared/agent.js";

const SYSTEM_READ_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/System",
  "/Library/Apple",
  "/Library/Developer",
  "/Applications/Xcode.app",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/select",
  "/dev",
  "/opt/homebrew",
  "/usr/local",
] as const;

export function isPermanentlyDeniedNetworkHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  ) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPermanentlyDeniedNetworkHost(normalized.slice("::ffff:".length));
  }
  const version = isIP(normalized);
  if (version === 4) {
    const [first = 0, second = 0] = normalized
      .split(".")
      .map((value) => Number(value));
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return (
    version === 6 &&
    (normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized))
  );
}

function applicationBundleRoot(path: string): string | undefined {
  const marker = ".app/";
  const index = path.indexOf(marker);
  return index === -1 ? undefined : path.slice(0, index + marker.length - 1);
}

function runtimeReadPaths(input: {
  workerPath: string;
  executablePath: string;
  ripgrepPath: string;
}): string[] {
  const executableBundle = applicationBundleRoot(input.executablePath);
  const workerArchive = input.workerPath.includes(".asar/")
    ? input.workerPath.slice(0, input.workerPath.indexOf(".asar/") + ".asar".length)
    : undefined;
  return [
    ...SYSTEM_READ_PATHS,
    input.workerPath,
    dirname(input.workerPath),
    input.executablePath,
    dirname(input.executablePath),
    input.ripgrepPath,
    dirname(input.ripgrepPath),
    ...(executableBundle === undefined ? [] : [executableBundle]),
    ...(workerArchive === undefined ? [] : [workerArchive]),
  ];
}

function protectedGitPaths(workspace: string): string[] {
  return [
    join(workspace, ".git"),
    join(workspace, "**/.git"),
    join(homedir(), "**/.git"),
    "/tmp/**/.git",
    "/private/tmp/**/.git",
    "/Volumes/**/.git",
  ];
}

function protectedGitReadPaths(workspace: string): string[] {
  const roots = [
    workspace,
    homedir(),
    "/tmp",
    "/private/tmp",
    "/Volumes",
  ];
  return roots.flatMap((root) => [
    join(root, ".git/config"),
    join(root, ".git/hooks"),
    join(root, "**/.git/config"),
    join(root, "**/.git/hooks/**"),
  ]);
}

function protectedCredentialPaths(): string[] {
  const userHome = homedir();
  return [
    join(userHome, ".ssh"),
    join(userHome, ".aws"),
    join(userHome, ".gnupg"),
    join(userHome, ".kube"),
    join(userHome, ".docker"),
    join(userHome, ".config/gh"),
    join(userHome, "Library"),
    join(userHome, "Library/Keychains"),
    join(userHome, "Library/Cookies"),
    join(userHome, "Library/Mail"),
    join(userHome, "Library/Messages"),
    join(userHome, "Library/Safari"),
    join(userHome, "Library/Application Support"),
  ];
}

function protectedSystemWritePaths(): string[] {
  return [
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/dev",
  ];
}

function containsPath(root: string, path: string): boolean {
  const difference = relative(resolve(root), resolve(path));
  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`))
  );
}

export function isProtectedAccessPath(
  workspace: string,
  path: string,
): boolean {
  const resolvedPath = resolve(workspace, path);
  if (
    resolvedPath
      .split(sep)
      .some((segment) => segment.toLocaleLowerCase() === ".git")
  ) {
    return true;
  }
  const protectedPaths = [
    ...protectedCredentialPaths(),
    ...protectedSystemWritePaths(),
  ];
  return protectedPaths.some(
    (protectedPath) =>
      containsPath(protectedPath, resolvedPath) ||
      containsPath(resolvedPath, protectedPath),
  );
}

function fullAccessWritePaths(workspace: string, sessionTemp: string): string[] {
  const userHome = homedir();
  const visibleHomeDirectories = readdirSync(userHome, {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "Library",
    )
    .map((entry) => join(userHome, entry.name));
  return [
    workspace,
    sessionTemp,
    "/tmp",
    "/private/tmp",
    "/Volumes",
    ...visibleHomeDirectories,
  ];
}

function defaultWriteDenials(workspace: string): string[] {
  const userHome = homedir();
  return [
    "/dev/tty",
    "/dev/dtracehelper",
    "/dev/autofs_nowait",
    "/tmp/claude",
    "/private/tmp/claude",
    ...protectedSystemWritePaths(),
    join(userHome, ".npm/_logs"),
    join(userHome, ".claude/debug"),
    ...protectedCredentialPaths(),
    ...protectedGitPaths(workspace),
  ];
}

export interface WorkerFilesystemGrant {
  path: string;
  access: "read" | "write";
}

export function createWorkerSandboxConfig(input: {
  workspace: string;
  sessionDir: string;
  workerTemp: string;
  workerPath: string;
  executablePath: string;
  ripgrepPath: string;
  accessMode: TaskAccessMode;
  interactionMode: TaskInteractionMode;
  agentCapability?: AgentCapability;
  grants?: WorkerFilesystemGrant[];
  allowedDomains: string[];
  credentials: NonNullable<SandboxRuntimeConfig["credentials"]>;
}): SandboxRuntimeConfig {
  const fullAccess = input.accessMode === "full";
  const readOnly =
    input.interactionMode === "plan" || input.agentCapability === "read";
  const workerDirectory = dirname(input.workerPath);
  const applicationRoot = resolve(workerDirectory, "../..");
  const runtimeReads = runtimeReadPaths({
    workerPath: input.workerPath,
    executablePath: input.executablePath,
    ripgrepPath: input.ripgrepPath,
  });
  const grantedReads = (input.grants ?? []).map((grant) => grant.path);
  const grantedWrites = (input.grants ?? [])
    .filter((grant) => grant.access === "write")
    .map((grant) => grant.path);
  return {
    network: {
      allowedDomains: input.allowedDomains,
      deniedDomains: [
        "localhost",
        "*.localhost",
        "127.0.0.1",
        "::1",
        "0.0.0.0",
        "169.254.169.254",
        "metadata.google.internal",
      ],
      strictAllowlist: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
      tlsTerminate: {},
    },
    filesystem: {
      denyRead: [
        ...(fullAccess ? protectedCredentialPaths() : ["/"]),
        ...protectedGitReadPaths(input.workspace),
      ],
      allowRead: [
        input.workspace,
        input.sessionDir,
        input.workerTemp,
        workerDirectory,
        join(applicationRoot, "node_modules"),
        ...runtimeReads,
        ...grantedReads,
      ],
      allowWrite: readOnly
        ? [input.sessionDir, input.workerTemp]
        : fullAccess
          ? [
              input.sessionDir,
              ...fullAccessWritePaths(input.workspace, input.workerTemp),
            ]
          : [
              input.workspace,
              input.sessionDir,
              input.workerTemp,
              ...grantedWrites,
            ],
      denyWrite: defaultWriteDenials(input.workspace).filter(
        (path) => !containsPath(path, input.sessionDir),
      ).concat(
        ["app.sqlite", "app.sqlite-wal", "app.sqlite-shm"].map((file) =>
          join(dirname(input.sessionDir), file),
        ),
      ),
      allowGitConfig: false,
    },
    allowAppleEvents: false,
    allowPty: false,
    ripgrep: { command: input.ripgrepPath },
    credentials: input.credentials,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function nodeCommandWithSandboxProxy(command: string): string {
  return [
    'HTTP_PROXY="${HTTP_PROXY/localhost/127.0.0.1}"',
    'HTTPS_PROXY="${HTTPS_PROXY/localhost/127.0.0.1}"',
    'http_proxy="${http_proxy/localhost/127.0.0.1}"',
    'https_proxy="${https_proxy/localhost/127.0.0.1}"',
    "NODE_USE_ENV_PROXY=1",
    "exec",
    command,
  ].join(" ");
}
