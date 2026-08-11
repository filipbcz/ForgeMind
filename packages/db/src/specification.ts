export function composeApprovedExtensionSpecification(
  currentSpecification: string,
  approvedExtension: string
): string {
  const current = currentSpecification.trim();
  const extension = approvedExtension.trim();

  if (!extension) {
    throw new Error('Approved project extension must not be empty.');
  }

  return [current, `## Approved extension\n${extension}`]
    .filter(Boolean)
    .join('\n\n');
}
