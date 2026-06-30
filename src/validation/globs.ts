export function globsMayOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftBase = literalBase(left);
  const rightBase = literalBase(right);

  if (leftBase.length === 0 || rightBase.length === 0) {
    return true;
  }

  return isSameOrDescendant(leftBase, rightBase) || isSameOrDescendant(rightBase, leftBase);
}

export function literalBase(glob: string): string {
  const normalized = normalizeGlob(glob);
  const segments = normalized.split("/");
  const literalSegments: string[] = [];

  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }

    if (hasGlobSyntax(segment)) {
      break;
    }

    literalSegments.push(segment);
  }

  return literalSegments.join("/");
}

function normalizeGlob(glob: string): string {
  return glob.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function hasGlobSyntax(segment: string): boolean {
  return /[*?[\]{}()!+@]/.test(segment);
}

function isSameOrDescendant(candidate: string, possibleParent: string): boolean {
  return candidate === possibleParent || candidate.startsWith(`${possibleParent}/`);
}
