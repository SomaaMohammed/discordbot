/** Normalize bounded role-menu text using JavaScript/Discord UTF-16 length. */
export function normalizeRoleMenuText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} contains unsupported control characters`);
  }
  return normalized;
}
