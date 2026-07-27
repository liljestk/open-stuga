function joinStyleModules(modules: Record<string, string>): string {
  return Object.entries(modules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => source)
    .join("\n");
}

const globalModules = import.meta.glob("../styles/global/*.css", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const outdoorWeatherModules = import.meta.glob("../pages/styles/outdoor-weather/*.css", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

export const globalStyles = joinStyleModules(globalModules);
export const outdoorWeatherStyles = joinStyleModules(outdoorWeatherModules);
