import { dirname } from "node:path";
import type { ProviderId } from "../../shared/contracts/provider";

export function buildProviderEnvironment(input: {
  provider: ProviderId;
  executableRealpath: string;
  homeDirectory: string;
  temporaryDirectory: string;
  userName: string;
  approvedPathEntries: readonly string[];
  source: NodeJS.ProcessEnv;
}): Record<string, string> {
  void input.provider;
  void input.source;
  const path = [dirname(input.executableRealpath), ...input.approvedPathEntries, "/usr/bin", "/bin"]
    .filter((entry, index, values) => values.indexOf(entry) === index);
  return {
    HOME: input.homeDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: input.userName,
    PATH: path.join(":"),
    SHELL: "/bin/zsh",
    TMPDIR: input.temporaryDirectory,
    USER: input.userName,
  };
}
