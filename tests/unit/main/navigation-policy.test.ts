import { describe, expect, it, vi } from "vitest";
import { openVerifiedExternal } from "../../../src/main/security/navigation-policy";

describe("openVerifiedExternal", () => {
  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>1</script>"])("rejects %s", async (url) => {
    const open = vi.fn();
    await expect(openVerifiedExternal(url, "gesture-1", async () => true, open)).rejects.toThrow("Only explicit HTTPS links can be opened");
    expect(open).not.toHaveBeenCalled();
  });
  it("requires a confirmed current user gesture", async () => {
    const open = vi.fn();
    await expect(openVerifiedExternal("https://example.com", "expired", async () => false, open)).rejects.toThrow("External link was not confirmed");
  });
});
