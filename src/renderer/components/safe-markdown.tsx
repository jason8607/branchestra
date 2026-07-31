import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

const DISALLOWED = ["img", "iframe", "object", "embed", "form", "input", "button", "svg"];

export function SafeMarkdown({ text }: { text: string }): React.JSX.Element {
  const inertText = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return (
    <ReactMarkdown
      rehypePlugins={[rehypeSanitize]}
      skipHtml
      disallowedElements={DISALLOWED}
      unwrapDisallowed
      components={{
        a: ({ children, href }) => {
          if (!href?.startsWith("https://")) return <span>{children}</span>;
          return (
            <a
              href={href}
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void window.branchestra.request({
                  type: "external.open",
                  payload: { url: href, userGestureNonce: crypto.randomUUID() },
                  idempotencyKey: crypto.randomUUID(),
                });
              }}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {inertText}
    </ReactMarkdown>
  );
}
