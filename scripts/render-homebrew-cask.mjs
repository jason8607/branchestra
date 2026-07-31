import { pathToFileURL } from "node:url";

export function renderCask({ owner, version, arm64Sha256, x64Sha256 }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw new Error("Owner must be a GitHub owner name");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Version must be stable semver");
  if (![arm64Sha256, x64Sha256].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("Checksums must be SHA-256 hex");
  return `cask "branchestra" do
  version "${version}"
  on_arm do
    sha256 "${arm64Sha256}"
    url "https://github.com/${owner}/branchestra/releases/download/v${version}/Branchestra-${version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "${x64Sha256}"
    url "https://github.com/${owner}/branchestra/releases/download/v${version}/Branchestra-${version}-mac-x64.dmg"
  end
  name "Branchestra"
  desc "Local-first orchestration workspace for coding agents"
  homepage "https://github.com/${owner}/branchestra"
  depends_on macos: ">= :monterey"
  app "Branchestra.app"
end
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { parseArgs } = await import("node:util");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { values } = parseArgs({ options: { owner: { type: "string" }, version: { type: "string" }, "arm64-sha256": { type: "string" }, "x64-sha256": { type: "string" }, output: { type: "string" } } });
  if (!values.owner || !values.version || !values["arm64-sha256"] || !values["x64-sha256"] || !values.output) throw new Error("owner, version, both checksums, and output are required");
  const output = path.resolve(values.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, renderCask({ owner: values.owner, version: values.version, arm64Sha256: values["arm64-sha256"], x64Sha256: values["x64-sha256"] }), { encoding: "utf8", flag: "wx" });
}
