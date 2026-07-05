import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

export async function readJsonIfExists(filePath, fallback = undefined) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${filePath} is not valid JSON: ${detail}`);
    }
    throw error;
  }
}

export async function writeJsonAtomic(filePath, data, mode = 0o600) {
  // JSON.stringify(undefined) is undefined, which would serialize to the literal
  // text "undefined" and write an unparseable file. Refuse rather than corrupt.
  if (data === undefined) {
    throw new TypeError(`writeJsonAtomic: refusing to write undefined to ${filePath}`);
  }
  await ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const body = `${JSON.stringify(data, null, 2)}\n`;
  try {
    const handle = await fs.promises.open(tempPath, "wx", mode);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    // Never leave the temp file behind on a failed write/sync/rename.
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const dirHandle = await fs.promises.open(path.dirname(filePath), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // dir fsync unsupported on some platforms; rename is still atomic
  }
}

export async function copyIfExists(source, destination) {
  try {
    await ensureDir(path.dirname(destination));
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(destination, 0o600);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "EEXIST") return true;
    throw error;
  }
}
