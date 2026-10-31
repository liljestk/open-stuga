import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const iosRoot = path.resolve(testsDirectory, "..");

async function source(relativePath) {
  return readFile(path.join(iosRoot, relativePath), "utf8");
}

function placeholderSignature(value) {
  const pattern = /%(?:(\d+)\$)?[-+0 #']*(?:\d+|\*)?(?:\.(?:\d+|\*))?(hh|h|ll|l|L|z|t|j)?([@diuoxXfFeEgGaAcCsSp%])/g;
  let implicitPosition = 1;
  return [...value.matchAll(pattern)]
    .filter((match) => match[3] !== "%")
    .map((match) => {
      const position = match[1] ? Number(match[1]) : implicitPosition++;
      return `${position}:${match[2] ?? ""}${match[3]}`;
    })
    .sort();
}

test("the general String Catalog ships complete Finnish and Swedish translations", async () => {
  const catalog = JSON.parse(
    await source("Stugu/Resources/Localizable.xcstrings"),
  );
  const entries = Object.entries(catalog.strings);
  assert.ok(entries.length > 0, "the general catalog must not be empty");

  for (const [key, entry] of entries) {
    for (const locale of ["fi", "sv"]) {
      const unit = entry.localizations?.[locale]?.stringUnit;
      assert.equal(unit?.state, "translated", `${key} is missing ${locale}`);
      assert.ok(unit?.value?.trim(), `${key} has an empty ${locale} value`);
      assert.deepEqual(
        placeholderSignature(unit.value),
        placeholderSignature(key),
        `${key} changes its placeholders in ${locale}`,
      );
    }
  }
});

test("ready-state errors are surfaced and dismissible", async () => {
  const mainTab = await source("Stugu/App/MainTabView.swift");
  assert.match(mainTab, /\.alert\("Needs attention", isPresented: Binding\(/);
  assert.match(mainTab, /get: \{ model\.errorMessage != nil \}/);
  assert.match(mainTab, /set: \{ if !\$0 \{ model\.errorMessage = nil \} \}/);
  assert.match(mainTab, /Text\(model\.errorMessage \?\? ""\)/);
});

test("the large-screen inventory deep link opens the inventory route", async () => {
  const largeScreen = await source("Stugu/App/LargeScreenExperienceView.swift");
  const inventoryCase = largeScreen.match(
    /case \.inventory:([\s\S]*?)case \.capture:/,
  )?.[1];
  assert.ok(inventoryCase, "the inventory deep-link case must exist");
  assert.match(inventoryCase, /\["properties", \$0, "inventory"\]/);
  assert.match(inventoryCase, /\?\? \["properties"\]/);
});

test("unknown Watch status stays neutral", async () => {
  const watchApp = await source("StuguWatch/StuguWatchApp.swift");
  const symbolSwitch = watchApp.match(
    /private func stateSymbol[\s\S]*?\n    \}/,
  )?.[0];
  const colorSwitch = watchApp.match(
    /private func stateColor[\s\S]*?\n    \}/,
  )?.[0];
  assert.match(symbolSwitch ?? "", /case "balanced": "checkmark\.circle\.fill"/);
  assert.match(symbolSwitch ?? "", /default: "circle\.dashed"/);
  assert.match(colorSwitch ?? "", /case "balanced": WatchPalette\.success/);
  assert.match(colorSwitch ?? "", /default: \.secondary/);
});

test("Watch and widget caution is straw yellow, never the lantern's orange", async () => {
  for (const file of ["StuguWatch/StuguWatchApp.swift", "StuguWidget/StuguWidget.swift"]) {
    const text = await source(file);
    assert.match(text, /static let caution = \w+\([^)]*0xE5CF62\)/, `${file} caution`);
    assert.doesNotMatch(text, /\.orange\b|0xF2B33D/i, `${file} must not use orange or the lantern`);
  }
});
