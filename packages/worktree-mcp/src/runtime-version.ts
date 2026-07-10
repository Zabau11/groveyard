import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMetadata = {
  name: string;
  version: string;
};

let cachedPackageMetadata: PackageMetadata | null = null;

export function getInstalledPackageMetadata(): PackageMetadata {
  if (cachedPackageMetadata) return cachedPackageMetadata;

  const packageRoot = getInstalledPackageRoot();
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Partial<PackageMetadata>;
  if (!metadata.name || !metadata.version) {
    throw new Error(`Unable to read package metadata from ${join(packageRoot, "package.json")}.`);
  }

  cachedPackageMetadata = {
    name: metadata.name,
    version: metadata.version,
  };
  return cachedPackageMetadata;
}

export function getInstalledPackageVersion(): string {
  return getInstalledPackageMetadata().version;
}

export function getInstalledPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
