export function renderInstallSection(githubOwner) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubOwner)) throw new Error("A validated GitHub owner is required for installation documentation");
  return `## Install on macOS

\`\`\`bash
brew install --cask ${githubOwner}/tap/branchestra
\`\`\`

Branchestra is a third-party local desktop app. Install and sign in to supported official Provider CLIs separately. Branchestra stores workflow data locally, but context selected for an Agent run is sent by that official CLI to its Provider. Public Claude subscription support remains unavailable until Anthropic approval is recorded in the repository policy gate.`;
}
