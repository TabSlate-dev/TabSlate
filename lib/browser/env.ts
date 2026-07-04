export function getBrowserBuild(): string {
  return import.meta.env.BROWSER;
}

export function isFirefoxBuild(): boolean {
  return getBrowserBuild() === "firefox";
}

export function isChromiumBuild(): boolean {
  return !isFirefoxBuild();
}
