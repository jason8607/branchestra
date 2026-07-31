import type { ProviderGitReadPort } from "./provider-git-read-port";

export interface ProviderEntryContext {
  git: ProviderGitReadPort;
  worktreeRootRealpath: string;
}
