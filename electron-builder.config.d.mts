export interface BranchestraBuilderConfig {
  appId: string;
  productName: string;
  electronVersion: string;
  asar: boolean;
  directories: { output: string };
  files: string[];
  extraResources: Array<{ from: string; to: string }>;
  mac: {
    category: string;
    minimumSystemVersion: string;
    target: string[];
    hardenedRuntime: boolean;
    gatekeeperAssess: boolean;
    forceCodeSigning: boolean;
    notarize: boolean;
    entitlements: string;
    entitlementsInherit: string;
    artifactName: string;
  };
  dmg: { sign: boolean };
  publish: null;
}

export function createBuilderConfig(
  environment: Readonly<Record<string, string | undefined>>,
): BranchestraBuilderConfig;

export function codexLockExtraResources(manifest: {
  repositoryPath: string;
  packagedRelativePath: string;
}): Array<{ from: string; to: string }>;

declare const config: BranchestraBuilderConfig;
export default config;
