import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export class StateStore {
  constructor(outputDir) {
    this.file = path.join(outputDir, "download-state.json");
    this.data = { version: 2, updatedAt: null, items: {} };
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await fsp.readFile(this.file, "utf8"));
      if (!this.data.items) this.data.items = {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(url) {
    return this.data.items[url] ?? null;
  }

  async update(url, patch) {
    this.data.items[url] = {
      ...(this.data.items[url] ?? { sourceUrl: url }),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.data.updatedAt = new Date().toISOString();
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      try {
        await fsp.rename(temp, this.file);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        await fsp.rm(this.file, { force: true });
        await fsp.rename(temp, this.file);
      }
    });
    await this.writeChain;
  }
}
