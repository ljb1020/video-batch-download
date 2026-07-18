import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const DEFAULT_LOCK_TIMEOUT_MS = 35_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncFile(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (!["EPERM", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function withFileLock(targetPath, callback, options = {}) {
  const lockPath = options.lockPath ?? `${targetPath}.agent-review.lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  let handle;
  let heartbeat = Promise.resolve();
  let heartbeatTimer = null;

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  while (!handle) {
    try {
      const candidate = await fsp.open(lockPath, "wx");
      try {
        await candidate.writeFile(JSON.stringify({ owner_token: ownerToken, pid: process.pid, created_at: new Date().toISOString() }));
        await candidate.sync();
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => {});
        await fsp.rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      let contention = error.code === "EEXIST";
      if (!contention && ["EACCES", "EPERM"].includes(error.code)) {
        try {
          await fsp.stat(lockPath);
          contention = true;
        } catch (statError) {
          if (statError.code === "ENOENT") throw error;
          throw statError;
        }
      }
      if (!contention) throw error;
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          const abandonedPath = `${lockPath}.stale.${randomUUID()}`;
          let tookOver = false;
          try {
            await fsp.rename(lockPath, abandonedPath);
            await fsp.rm(abandonedPath, { force: true });
            tookOver = true;
          } catch (takeoverError) {
            if (!["ENOENT", "EACCES", "EPERM"].includes(takeoverError.code)) throw takeoverError;
          }
          if (tookOver) continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const error = new Error(`Timed out waiting for review lock: ${lockPath}`);
        error.code = "REVIEW_LOCK_TIMEOUT";
        throw error;
      }
      await delay(25);
    }
  }

  const heartbeatMs = Math.max(10, Math.floor(staleLockMs / 3));
  heartbeatTimer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      const current = new Date();
      await handle.utimes(current, current);
    }).catch(() => {});
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  try {
    return await callback();
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeat;
    await handle.close().catch(() => {});
    try {
      const current = JSON.parse(await fsp.readFile(lockPath, "utf8"));
      if (current.owner_token === ownerToken) await fsp.rm(lockPath, { force: true });
    } catch {
      // The lock was taken over or already removed. Never delete an unknown owner.
    }
  }
}

export function createReplacementPaths(targetPath, tag = randomUUID()) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return {
    stagePath: path.join(dir, `.${base}.${tag}.stage`),
    backupPath: path.join(dir, `.${base}.${tag}.backup`),
  };
}

export async function writeUtf8File(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fsp.open(filePath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(filePath, value) {
  await recoverAtomicFile(filePath);
  const stagePath = `${filePath}.agent-review.${process.pid}.${randomUUID()}.tmp`;
  const backupPath = `${filePath}.agent-review.backup`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await writeUtf8File(stagePath, `${JSON.stringify(value, null, 2)}\n`);

  let movedOriginal = false;
  try {
    if (await pathExists(filePath)) {
      await fsp.rename(filePath, backupPath);
      movedOriginal = true;
    }
    await fsp.rename(stagePath, filePath);
    await syncFile(filePath);
    if (movedOriginal) await fsp.rm(backupPath, { force: true });
  } catch (error) {
    if (!(await pathExists(filePath)) && movedOriginal && await pathExists(backupPath)) {
      await fsp.rename(backupPath, filePath).catch(() => {});
    }
    await fsp.rm(stagePath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function recoverAtomicFile(filePath) {
  const backupPath = `${filePath}.agent-review.backup`;
  const hasTarget = await pathExists(filePath);
  const hasBackup = await pathExists(backupPath);
  if (!hasBackup) return { recovered: false };
  if (hasTarget) {
    try {
      JSON.parse(await fsp.readFile(filePath, "utf8"));
      await fsp.rm(backupPath, { force: true });
      return { recovered: false, cleanedBackup: true };
    } catch {
      JSON.parse(await fsp.readFile(backupPath, "utf8"));
      const corruptPath = `${filePath}.corrupt.${randomUUID()}`;
      await fsp.rename(filePath, corruptPath);
      try {
        await fsp.rename(backupPath, filePath);
        await fsp.rm(corruptPath, { force: true });
        return { recovered: true, replacedCorruptTarget: true };
      } catch (error) {
        if (!(await pathExists(filePath))) await fsp.rename(corruptPath, filePath).catch(() => {});
        throw error;
      }
    }
  }
  JSON.parse(await fsp.readFile(backupPath, "utf8"));
  await fsp.rename(backupPath, filePath);
  return { recovered: true };
}

export async function replaceFileRecoverably({
  targetPath,
  sourcePath,
  stagePath,
  backupPath,
  expectedSourceHash,
  expectedTargetHash,
  hashFile,
}) {
  if (typeof hashFile !== "function") throw new TypeError("hashFile must be a function");
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });

  const currentTargetHash = await hashFile(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (currentTargetHash === expectedTargetHash) {
    return { status: "already_replaced", backupPath };
  }
  if (currentTargetHash !== expectedSourceHash && currentTargetHash !== null) {
    const error = new Error("Official transcript changed before commit");
    error.code = "REVIEW_STALE_TARGET";
    throw error;
  }
  if (currentTargetHash === null) {
    const backupHash = await hashFile(backupPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (backupHash !== expectedSourceHash) {
      const error = new Error("Official transcript is missing without a valid source backup");
      error.code = "REVIEW_STALE_TARGET";
      throw error;
    }
  }

  const sourceHash = await hashFile(sourcePath);
  if (sourceHash !== expectedTargetHash) {
    const error = new Error("Review work file hash does not match commit target");
    error.code = "REVIEW_STALE_WORK";
    throw error;
  }

  if (!(await pathExists(stagePath))) {
    await fsp.copyFile(sourcePath, stagePath, fsConstants.COPYFILE_EXCL);
    await syncFile(stagePath);
  } else if (await hashFile(stagePath) !== expectedTargetHash) {
    const error = new Error("Existing commit stage has an unexpected hash");
    error.code = "REVIEW_STALE_STAGE";
    throw error;
  }

  let movedOriginal = await pathExists(backupPath);
  try {
    if (await pathExists(targetPath)) {
      if (movedOriginal) {
        const backupHash = await hashFile(backupPath);
        if (backupHash !== expectedSourceHash) {
          const error = new Error("Existing transcript backup has an unexpected hash");
          error.code = "REVIEW_STALE_BACKUP";
          throw error;
        }
      } else {
        await fsp.rename(targetPath, backupPath);
        movedOriginal = true;
      }
    }
    await fsp.rename(stagePath, targetPath);
    await syncFile(targetPath);
    if (await hashFile(targetPath) !== expectedTargetHash) {
      const error = new Error("Committed transcript failed hash verification");
      error.code = "REVIEW_COMMIT_HASH_MISMATCH";
      throw error;
    }
    return { status: "replaced", backupPath };
  } catch (error) {
    if (!(await pathExists(targetPath)) && movedOriginal && await pathExists(backupPath)) {
      await fsp.rename(backupPath, targetPath).catch(() => {});
    }
    throw error;
  }
}

export async function cleanupReplacement({ stagePath, backupPath }) {
  await Promise.all([
    stagePath ? fsp.rm(stagePath, { force: true }).catch(() => {}) : Promise.resolve(),
    backupPath ? fsp.rm(backupPath, { force: true }).catch(() => {}) : Promise.resolve(),
  ]);
}

export { pathExists };
