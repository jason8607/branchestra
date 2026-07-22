import { pathToFileURL } from "node:url";

export type RendererLocation =
  | { kind: "file"; url: string }
  | { kind: "url"; url: string };

export function resolveRendererLocation(options: {
  isPackaged: boolean;
  rendererEntry: string;
  developmentUrl: string | undefined;
}): RendererLocation {
  const packaged = { kind: "file", url: pathToFileURL(options.rendererEntry).href } as const;
  if (options.isPackaged || options.developmentUrl === undefined) return packaged;
  let parsed: URL;
  try {
    parsed = new URL(options.developmentUrl);
  } catch {
    throw new Error("Development renderer must be a trusted loopback Vite origin");
  }
  const trustedHost = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  const exactOrigin = parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  if (
    !trustedHost
    || (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || !exactOrigin
  ) {
    throw new Error("Development renderer must be a trusted loopback Vite origin");
  }
  return { kind: "url", url: parsed.href };
}
