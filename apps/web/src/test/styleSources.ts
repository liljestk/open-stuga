const stylesheets = import.meta.glob(["../*.css", "../styles/**/*.css", "../pages/**/*.css"], {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

/** The `../`-relative glob key of `specifier` imported from the stylesheet at `from`. */
function importedPath(from: string, specifier: string): string {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") segments.pop();
    else if (part !== ".") segments.push(part);
  }
  return segments.join("/");
}

/**
 * The fragments a stylesheet @imports from under `within`, joined in its @import order, which is the
 * cascade order the bundler produces.
 */
function importedFragments(sheet: string, within: string): string {
  const source = stylesheets[sheet];
  if (source === undefined) throw new Error(`No stylesheet ${sheet}`);
  return [...source.matchAll(/@import\s+"([^"]+)";/gu)]
    .map((match) => importedPath(sheet, match[1]!))
    .filter((path) => path.startsWith(within))
    .map((path) => {
      const fragment = stylesheets[path];
      if (fragment === undefined) throw new Error(`${sheet} imports missing ${path}`);
      return fragment;
    })
    .join("\n");
}

export const globalStyles = importedFragments("../styles.css", "../styles/global/");
export const outdoorWeatherStyles = importedFragments("../pages/OutdoorWeatherPage.css", "../pages/OutdoorWeatherPage/");

/** One rule's declarations in source order, so fallbacks such as `100vh` before `100dvh` stay checkable. */
export interface CssRule {
  /** Every declaration, as [property, value] pairs in source order. */
  declarations: Array<[string, string]>;
  /** The last value declared for `property`, as the cascade would use it. */
  get(property: string): string | undefined;
  /** Every value declared for `property`, in source order. */
  values(property: string): string[];
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Splits a selector list on its top-level commas, leaving `:is(a, b)` whole. */
function selectorList(prelude: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of prelude) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      selectors.push(normalize(current));
      current = "";
    } else {
      current += character;
    }
  }
  selectors.push(normalize(current));
  return selectors;
}

/** The text between the brace at `open` and its matching close. */
function blockBody(source: string, open: number): { body: string; close: number } {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return { body: source.slice(open + 1, index), close: index };
  }
  throw new Error("Unbalanced braces in stylesheet");
}

/** Top-level rules of a block: at-rules keep their prelude, so callers can descend into one. */
function rules(source: string): Array<{ prelude: string; body: string }> {
  const found: Array<{ prelude: string; body: string }> = [];
  let start = 0;
  for (let open = source.indexOf("{", start); open >= 0; open = source.indexOf("{", start)) {
    const { body, close } = blockBody(source, open);
    const raw = source.slice(start, open);
    found.push({ prelude: normalize(raw.slice(raw.lastIndexOf(";") + 1)), body });
    start = close + 1;
  }
  return found;
}

/**
 * The declarations of every rule whose selector list includes `selector`, inside the
 * `@media` block whose condition is `media` when given (or the at-rule `media` names when it
 * starts with `@`, such as `@container building-scene (max-width: 760px)`), otherwise outside
 * any at-rule. Declaration order inside and across rules is kept; order between properties is not asserted.
 */
export function cssRule(source: string, selector: string, media?: string): CssRule {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const atRule = media?.startsWith("@") ? normalize(media) : `@media ${normalize(media ?? "")}`;
  const scopes = media === undefined
    ? [withoutComments]
    : rules(withoutComments).filter((rule) => rule.prelude === atRule).map((rule) => rule.body);
  const declarations: Array<[string, string]> = [];
  const wanted = normalize(selector);
  for (const scope of scopes) {
    for (const rule of rules(scope)) {
      if (rule.prelude.startsWith("@") || !selectorList(rule.prelude).includes(wanted)) continue;
      for (const declaration of rule.body.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon > 0) declarations.push([normalize(declaration.slice(0, colon)), normalize(declaration.slice(colon + 1))]);
      }
    }
  }
  if (declarations.length === 0) throw new Error(`No rule for ${selector}${media ? ` inside ${atRule}` : ""}`);
  return {
    declarations,
    get: (property) => declarations.filter(([name]) => name === property).at(-1)?.[1],
    values: (property) => declarations.filter(([name]) => name === property).map(([, value]) => value),
  };
}
