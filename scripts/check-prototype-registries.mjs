import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const registryDefinitions = [
  {
    directory: "apps/api/src/db",
    publicType: "ClimateDatabaseCore",
    internalsType: "DatabaseInternals",
    registerFunction: "registerDatabaseMethods",
  },
  {
    directory: "apps/api/src/home-assistant",
    publicType: "HomeAssistantConnectionBridgeCore",
    internalsType: "HomeAssistantConnectionBridgeInternals",
    registerFunction: "registerHomeAssistantConnectionBridgeMethods",
  },
  {
    directory: "apps/api/src/tp-link",
    publicType: "TpLinkConnectionBridgeCore",
    internalsType: "TpLinkConnectionBridgeInternals",
    registerFunction: "registerTpLinkConnectionBridgeMethods",
  },
  {
    directory: "apps/api/src/tapo-history-export",
    publicType: "TapoHistoryExportServiceCore",
    internalsType: "TapoHistoryExportServiceInternals",
    registerFunction: "registerTapoHistoryExportServiceMethods",
  },
  {
    directory: "apps/api/src/timeseries/store",
    publicType: "TimeseriesStoreCore",
    internalsType: "TimeseriesStoreInternals",
    registerFunction: "registerTimeseriesStoreMethods",
  },
  {
    directory: "apps/api/src/spatial-layers/state-store",
    publicType: "SpatialLayerStateStoreCore",
    internalsType: "SpatialLayerStateStoreInternals",
    registerFunction: "registerSpatialLayerStateStoreMethods",
  },
  {
    directory: "apps/api/src/stuguby/store",
    publicType: "StugubyStoreCore",
    internalsType: "StugubyStoreInternals",
    registerFunction: "registerStugubyStoreMethods",
  },
  {
    directory: "apps/api/src/stuguby/service",
    publicType: "StugubyServiceCore",
    internalsType: "StugubyServiceInternals",
    registerFunction: "registerStugubyServiceMethods",
  },
  {
    directory: "apps/tapo-export-runner/src/webdriver",
    publicType: "AppiumClientCore",
    internalsType: "AppiumClientInternals",
    registerFunction: "registerAppiumClientMethods",
  },
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

function projectPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function memberName(member) {
  const name = member.name;
  if (!name || ts.isComputedPropertyName(name)) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
    || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function methodNamesFromInterface(node) {
  return node.members
    .filter((member) => ts.isMethodSignature(member))
    .map(memberName)
    .filter((name) => name !== null);
}

function concreteMethodNames(node) {
  return node.members
    .filter((member) => ts.isMethodDeclaration(member)
      || ts.isGetAccessorDeclaration(member)
      || ts.isSetAccessorDeclaration(member))
    .map(memberName)
    .filter((name) => name !== null);
}

function registeredObjectMethods(root, path, source, definition, violations, registrations) {
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === definition.registerFunction) {
      const argument = node.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) {
        violations.push(
          `${projectPath(root, path)}: ${definition.registerFunction} must receive an object literal`,
        );
      } else {
        for (const property of argument.properties) {
          if (!ts.isMethodDeclaration(property) && !ts.isPropertyAssignment(property)) {
            violations.push(
              `${projectPath(root, path)}: ${definition.registerFunction} cannot use spreads or shorthand properties`,
            );
            continue;
          }
          const name = memberName(property);
          if (name === null) {
            violations.push(
              `${projectPath(root, path)}: registered method names must be static identifiers`,
            );
            continue;
          }
          const previous = registrations.get(name);
          if (previous) {
            violations.push(
              `${projectPath(root, path)}: ${name} is already registered in ${previous}`,
            );
          } else {
            registrations.set(name, projectPath(root, path));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export async function prototypeRegistryViolations(root) {
  const violations = [];
  for (const definition of registryDefinitions) {
    const directory = join(root, definition.directory);
    const publicMethods = new Set();
    const internalMethods = new Set();
    const concreteMethods = new Set();
    const registrations = new Map();
    for (const path of await sourceFiles(directory)) {
      const text = await readFile(path, "utf8");
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      function collectDeclarations(node) {
        if (ts.isInterfaceDeclaration(node)) {
          const target = node.name.text === definition.publicType
            ? publicMethods
            : node.name.text === definition.internalsType
              ? internalMethods
              : null;
          if (target) {
            for (const name of methodNamesFromInterface(node)) target.add(name);
          }
        }
        if (ts.isClassDeclaration(node) && node.name?.text === definition.publicType) {
          for (const name of concreteMethodNames(node)) concreteMethods.add(name);
        }
        ts.forEachChild(node, collectDeclarations);
      }
      collectDeclarations(source);
      registeredObjectMethods(root, path, source, definition, violations, registrations);
    }

    for (const name of concreteMethods) internalMethods.delete(name);
    const location = definition.directory;
    for (const name of [...internalMethods].sort()) {
      if (!registrations.has(name)) {
        violations.push(`${location}: declared internal method ${name} is never registered`);
      }
    }
    for (const [name, source] of [...registrations].sort(([left], [right]) => left.localeCompare(right))) {
      if (!internalMethods.has(name) && !concreteMethods.has(name)) {
        violations.push(`${source}: registered method ${name} has no internal declaration`);
      }
    }
    for (const name of [...publicMethods].sort()) {
      if (!internalMethods.has(name) && !concreteMethods.has(name)) {
        violations.push(`${location}: public method ${name} has no internal implementation contract`);
      }
    }
  }
  return violations;
}
