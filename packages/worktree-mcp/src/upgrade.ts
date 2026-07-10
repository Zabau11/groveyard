import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { getInstalledPackageMetadata, getInstalledPackageRoot, getInstalledPackageVersion } from "./runtime-version.js";

const execFileAsync = promisify(execFile);
const packageName = "@groveyard/mcp";
const installArgs = ["install", "-g", `${packageName}@latest`];
const npmTimeoutMs = 120_000;

export type UpgradeStatus = "current" | "available" | "updated" | "manual" | "error";

export type UpgradeReport = {
  status: UpgradeStatus;
  currentVersion: string;
  latestVersion?: string;
  isGlobalInstall: boolean;
  installCommand: string;
  changed: boolean;
  error?: string;
};

export type UpgradeOptions = {
  check?: boolean;
  yes?: boolean;
};

export async function checkForUpgrade(): Promise<UpgradeReport> {
  return runUpgrade({ check: true, yes: false });
}

export async function runUpgrade(options: UpgradeOptions): Promise<UpgradeReport> {
  const currentVersion = getInstalledPackageVersion();
  const installCommand = `npm ${installArgs.join(" ")}`;
  const isGlobalInstall = await isGlobalPackageInstall();

  let latestVersion: string;
  try {
    latestVersion = await fetchLatestVersion();
  } catch (error) {
    return {
      status: "error",
      currentVersion,
      isGlobalInstall,
      installCommand,
      changed: false,
      error: formatExecError(error),
    };
  }

  if (latestVersion === currentVersion) {
    return {
      status: "current",
      currentVersion,
      latestVersion,
      isGlobalInstall,
      installCommand,
      changed: false,
    };
  }

  if (!isGlobalInstall) {
    return {
      status: "manual",
      currentVersion,
      latestVersion,
      isGlobalInstall,
      installCommand,
      changed: false,
    };
  }

  if (options.check) {
    return {
      status: "available",
      currentVersion,
      latestVersion,
      isGlobalInstall,
      installCommand,
      changed: false,
    };
  }

  if (!options.yes) {
    const confirmed = await confirmUpgrade(currentVersion, latestVersion);
    if (!confirmed) {
      return {
        status: "available",
        currentVersion,
        latestVersion,
        isGlobalInstall,
        installCommand,
        changed: false,
      };
    }
  }

  try {
    await runNpm(installArgs);
  } catch (error) {
    return {
      status: "error",
      currentVersion,
      latestVersion,
      isGlobalInstall,
      installCommand,
      changed: false,
      error: formatExecError(error),
    };
  }

  const installedVersion = await readInstalledGlobalVersion().catch(() => latestVersion);
  return {
    status: "updated",
    currentVersion: installedVersion,
    latestVersion,
    isGlobalInstall,
    installCommand,
    changed: true,
  };
}

async function fetchLatestVersion(): Promise<string> {
  if (process.env.GROVEYARD_TEST_NPM_VIEW_VERSION) return process.env.GROVEYARD_TEST_NPM_VIEW_VERSION;
  const stdout = await runNpm(["view", packageName, "version", "--json"]);
  const parsed = JSON.parse(stdout) as string | { version?: string };
  const version = typeof parsed === "string" ? parsed : parsed.version;
  if (!version || !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
    throw new Error(`npm returned an invalid latest version for ${packageName}.`);
  }
  return version;
}

async function isGlobalPackageInstall(): Promise<boolean> {
  if (process.env.GROVEYARD_TEST_IS_GLOBAL_INSTALL === "1") return true;
  if (process.env.GROVEYARD_TEST_IS_GLOBAL_INSTALL === "0") return false;
  try {
    const [globalRoot, installedRoot] = await Promise.all([
      npmGlobalRoot(),
      realpath(getInstalledPackageRoot()),
    ]);
    return installedRoot === join(globalRoot, ...packageName.split("/"));
  } catch {
    return false;
  }
}

async function readInstalledGlobalVersion(): Promise<string> {
  if (process.env.GROVEYARD_TEST_INSTALLED_GLOBAL_VERSION) return process.env.GROVEYARD_TEST_INSTALLED_GLOBAL_VERSION;
  const stdout = await runNpm(["root", "-g"]);
  const globalRoot = stdout.trim();
  const metadataPath = join(globalRoot, ...packageName.split("/"), "package.json");
  const metadata = JSON.parse(await execRead(metadataPath)) as { version?: string };
  if (!metadata.version) throw new Error(`Unable to read upgraded version from ${metadataPath}.`);
  return metadata.version;
}

async function npmGlobalRoot(): Promise<string> {
  if (process.env.GROVEYARD_TEST_NPM_ROOT) return realpath(process.env.GROVEYARD_TEST_NPM_ROOT);
  return realpath((await runNpm(["root", "-g"])).trim());
}

async function runNpm(args: string[]): Promise<string> {
  const npmCommand = process.env.GROVEYARD_TEST_NPM_COMMAND || "npm";
  const { stdout } = await execFileAsync(npmCommand, args, {
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
    timeout: npmTimeoutMs,
  });
  return stdout.trim();
}

async function execRead(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function confirmUpgrade(currentVersion: string, latestVersion: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Upgrade Groveyard ${currentVersion} -> ${latestVersion}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function formatExecError(error: unknown): string {
  if (isExecError(error)) {
    return [error.stderr, error.stdout, error.message].filter(Boolean).join("\n").trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}

export function formatUpgradeReport(report: UpgradeReport): string {
  switch (report.status) {
    case "current":
      return `Groveyard ${report.currentVersion} is current.`;
    case "available":
      return `Update available: ${report.currentVersion} -> ${report.latestVersion}\nRun \`groveyard upgrade\` to install it.`;
    case "updated":
      return `Groveyard updated to ${report.currentVersion}.\nRestart Codex, Claude Code, VS Code, Cursor, or any other coding app so its MCP process reloads.`;
    case "manual":
      return `Groveyard is not running from a global installation.\nRun \`${report.installCommand}\``;
    case "error":
      return report.error ?? "Upgrade failed.";
  }
}

export function getPackageName(): string {
  return getInstalledPackageMetadata().name;
}
