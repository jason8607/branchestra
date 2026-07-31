import { expect, it } from "vitest";
import { renderCask } from "../../../scripts/render-homebrew-cask.mjs";

it("selects a distinct notarized DMG and checksum for each CPU", () => {
  const cask = renderCask({ owner: "example", version: "1.2.3", arm64Sha256: "a".repeat(64), x64Sha256: "b".repeat(64) });
  expect(cask).toContain("on_arm do");
  expect(cask).toContain("Branchestra-1.2.3-mac-arm64.dmg");
  expect(cask).toContain("Branchestra-1.2.3-mac-x64.dmg");
  expect(cask).toContain('app "Branchestra.app"');
  expect(cask).not.toContain("auto_updates true");
});
