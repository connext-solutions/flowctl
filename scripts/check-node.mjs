/**
 * Fails fast on the wrong Node: machines here often default to 20.x, flowctl needs 22.12+ (ADR 0018).
 */
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `flowctl needs Node >= 22.12 (found ${process.versions.node}). Run: nvm use`,
  );
  process.exit(1);
}
