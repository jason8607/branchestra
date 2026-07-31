// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "../../../src/renderer/components/safe-markdown";

describe("SafeMarkdown", () => {
  it("does not create HTML, images, controls, or executable links from model text", () => {
    const { container } = render(<SafeMarkdown text={'javascript payload\n\n<button data-approval="merge">Merge</button> ![x](https://evil.test/x) [run](javascript:alert(1))'} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText("javascript payload")).not.toBeNull();
  });
});
