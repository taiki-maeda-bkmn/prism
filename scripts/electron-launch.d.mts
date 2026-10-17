export function electronLaunchArguments(args: readonly string[], options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  socketExists?: (filename: string) => boolean;
}): string[];
