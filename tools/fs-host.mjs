/* 测试用的 fs 宿主：签名与 sidecar 完全一致，只回 sidecar 会回的那些字段。
 * store.test.mjs / migrate.test.mjs 共用，避免两份实现悄悄漂移。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export function fsHost(overrides) {
  const host = {
    list: async (dir) => {
      const names = await fsp.readdir(dir).catch(() => []);
      const files = [];
      for (const n of names) {
        if (!/\.(http|rest)$/i.test(n)) continue;
        const p = path.join(dir, n);
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        files.push({ path: p, name: n, size: st.size, modified: Math.round(st.mtimeMs) });
      }
      return { dir, files };
    },
    read: async (p) => ({ path: p, content: await fsp.readFile(p, 'utf8'), name: path.basename(p), dir: path.dirname(p) }),
    stat: async (p) => {
      try {
        const st = await fsp.stat(p);
        return { path: p, exists: true, isDir: st.isDirectory(), size: st.size, modified: Math.round(st.mtimeMs) };
      } catch {
        return { path: p, exists: false, isDir: false, size: 0, modified: 0 };
      }
    },
    write: async (p, content) => { await fsp.writeFile(p, content, 'utf8'); return { path: p, written: true }; },
    rename: async (from, to, o) => {
      if (!o || !o.overwrite) {
        const st = await fsp.stat(to).catch(() => null);
        if (st) return { path: to, exists: true, renamed: false };
      }
      await fsp.rename(from, to);
      return { path: to, exists: false, renamed: true };
    },
    remove: async (p) => { await fsp.rm(p, { force: true }); return { path: p, removed: true }; },
    ensureDir: async (d) => { await fsp.mkdir(d, { recursive: true }); return { dir: d, ok: true }; },
  };
  return Object.assign(host, overrides || {});
}
