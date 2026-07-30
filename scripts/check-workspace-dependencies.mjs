import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

async function workspacePackages(root) {
  const packages = [];
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, parent, entry.name);
      try {
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (typeof manifest.name !== "string" || !manifest.name) continue;
        packages.push({
          name: manifest.name,
          directory: relative(root, directory).split(sep).join("/"),
          kind: parent === "apps" ? "app" : "package",
          dependencies: {
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
            ...manifest.peerDependencies,
            ...manifest.devDependencies,
          },
        });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return packages;
}

export async function workspaceDependencyViolations(root) {
  const packages = await workspacePackages(root);
  const byName = new Map(packages.map((workspace) => [workspace.name, workspace]));
  const graph = new Map();
  const violations = [];

  for (const workspace of packages) {
    const internal = Object.keys(workspace.dependencies)
      .filter((dependency) => byName.has(dependency))
      .sort();
    graph.set(workspace.name, internal);
    for (const dependency of internal) {
      const target = byName.get(dependency);
      if (workspace.kind === "package" && target?.kind === "app") {
        violations.push(
          `${workspace.directory}/package.json: reusable packages may not depend on ${target.directory}`,
        );
      }
      if (workspace.kind === "app" && target?.kind === "app") {
        violations.push(
          `${workspace.directory}/package.json: applications may not depend directly on ${target.directory}`,
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name, path) {
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      violations.push(`workspace dependency cycle: ${[...path.slice(start), name].join(" -> ")}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of [...graph.keys()].sort()) visit(name, []);

  return [...new Set(violations)];
}
