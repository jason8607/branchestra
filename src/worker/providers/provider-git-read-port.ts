import type { GitReadService } from "../git/repository-inspector";

export type ProviderGitReadPort = Pick<
  GitReadService,
  "status" | "diff" | "show" | "log"
>;
