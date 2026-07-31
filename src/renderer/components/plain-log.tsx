import React from "react";

export function PlainLog({ text }: { text: string }): React.JSX.Element {
  return <pre className="plain-log">{text.replaceAll("\u001b", "\\u001b")}</pre>;
}
