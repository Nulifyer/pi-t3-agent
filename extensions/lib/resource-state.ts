import { existsSync, readdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function resourceRoots(cwd: string, agentDir: string, home: string) {
  const roots = [join(home, ".agents", "skills"), join(home, ".agents", "AGENTS.md")];
  for (const name of ["skills", "prompts", "extensions", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "settings.json", "models.json", "pi-t3-agent.json", "web-search.json"])
    roots.push(join(agentDir, name));
  for (let directory = cwd; ; directory = dirname(directory)) {
    for (const name of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".agents/skills", ".pi/skills", ".pi/prompts", ".pi/extensions", ".pi/settings.json", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"])
      roots.push(join(directory, name));
    if (existsSync(join(directory, ".git")) || dirname(directory) === directory) break;
  }
  return [...new Set(roots)];
}

export function resourceFingerprint(roots: Iterable<string>, dynamicProvider?: string) {
  const records: string[] = [];
  const visited = new Set<string>();
  const visit = (path: string) => {
    let stat, real;
    try { stat = statSync(path); real = realpathSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (visited.has(real)) return;
    visited.add(real);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!name.startsWith(".") && name !== "node_modules") visit(join(path, name));
    } else if (dynamicProvider && basename(path) === "models.json") {
      const document = JSON.parse(readFileSync(path, "utf8"));
      if (document.providers?.[dynamicProvider]) delete document.providers[dynamicProvider].models;
      records.push(`${real}:${JSON.stringify(document)}`);
    } else if (/\.(?:md|json|ts|js|mjs|cjs)$/i.test(path)) records.push(`${real}:${stat.mtimeMs}:${stat.size}`);
  };
  for (const root of roots) visit(root);
  return records.sort().join("\n");
}
