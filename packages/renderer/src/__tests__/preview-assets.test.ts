/**
 * Static guards for the preview window assets in `src/assets/`.
 *
 * `preview-preload.js` is copied verbatim to `dist/assets/` (not bundled) and
 * loads the built client entry by a relative path. These tests pin that path
 * to the package's public `./client` CJS export so a change to the build
 * output layout or the exports map fails here instead of at preview runtime.
 * They compute paths only and never depend on `dist/` existing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(__dirname, "../..");
const assetsDir = path.join(packageRoot, "src/assets");
const distAssetsDir = path.join(packageRoot, "dist/assets");

const readAsset = (filename: string): string =>
  readFileSync(path.join(assetsDir, filename), "utf8");

interface PackageJSON {
  files: string[];
  exports: Record<string, { require?: string }>;
}

const readPackageJSON = (): PackageJSON =>
  JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageJSON;

const extractRequireSpecifiers = (source: string): string[] =>
  Array.from(source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g), (match) => match[1] ?? "");

describe("preview-preload.js", () => {
  const preload = readAsset("preview-preload.js");

  it("requires only electron and the built client entry", () => {
    expect(extractRequireSpecifiers(preload)).toEqual(["electron", "../client/index.cjs"]);
  });

  it("resolves its client require (from dist/assets) to the package's ./client CJS export", () => {
    const pkg = readPackageJSON();
    const clientExport = pkg.exports["./client"]?.require;
    if (!clientExport) throw new Error('package.json exports["./client"].require is missing');

    const [clientSpecifier] = extractRequireSpecifiers(preload).filter((s) => s !== "electron");
    if (!clientSpecifier) throw new Error("preload has no client require");

    expect(path.resolve(distAssetsDir, clientSpecifier)).toBe(
      path.resolve(packageRoot, clientExport),
    );
    // Both the preload and the client entry ship under dist/.
    expect(pkg.files).toContain("dist");
  });

  it("binds through bindSharedTextureReceiver instead of the raw Electron slot", () => {
    expect(preload).toContain("bindSharedTextureReceiver(");
    expect(preload).not.toMatch(/\.setSharedTextureReceiver\(/);
  });

  it("leaves VideoFrame.close / imported.release to consume()", () => {
    expect(preload).not.toMatch(/\.close\(\)/);
    expect(preload).not.toMatch(/\.release\(\)/);
  });

  it("disposes the binding on beforeunload and still acks preview-ready", () => {
    expect(preload).toMatch(/"beforeunload",\s*\(\)\s*=>\s*receiver\.dispose\(\)/);
    expect(preload).toContain('ipcRenderer.send("preview-ready")');
  });

  it("does not expose anything to the main world", () => {
    expect(preload).not.toContain("contextBridge");
  });
});

describe("preview.html", () => {
  const html = readAsset("preview.html");

  it("is markup and styles only (drawing lives in the preload)", () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain("electronAPI");
  });

  it("provides the elements the preload draws into", () => {
    expect(html).toContain('id="preview"');
    expect(html).toContain('id="info"');
  });
});
