import { describe, expect, it } from "vitest";
import { buildProviderEnvironment } from "../../../src/worker/providers/provider-environment";

describe("provider child environment", () => {
  it.each(["claude", "codex"] as const)("omits inherited credentials for %s", (provider) => {
    const env = buildProviderEnvironment({
      provider,
      executableRealpath: `/opt/homebrew/bin/${provider}`,
      homeDirectory: "/Users/tester",
      temporaryDirectory: "/private/tmp/tester",
      userName: "tester",
      approvedPathEntries: ["/Users/tester/project/node_modules/.bin"],
      source: {
        ANTHROPIC_API_KEY: "secret-a", CLAUDE_CODE_OAUTH_TOKEN: "secret-b", OPENAI_API_KEY: "secret-c",
        CODEX_API_KEY: "secret-d", ANTHROPIC_BASE_URL: "https://custom.invalid", OPENAI_BASE_URL: "https://custom.invalid",
        AWS_PROFILE: "prod", CLAUDE_CODE_USE_VERTEX: "1", NODE_OPTIONS: "--require /tmp/inject.cjs",
      },
    });
    expect(env).toEqual({
      HOME: "/Users/tester", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", LOGNAME: "tester",
      PATH: `/opt/homebrew/bin:/Users/tester/project/node_modules/.bin:/usr/bin:/bin`,
      SHELL: "/bin/zsh", TMPDIR: "/private/tmp/tester", USER: "tester",
    });
  });
});
