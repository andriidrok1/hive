export function isMock(search: string = typeof location !== "undefined" ? location.search : ""): boolean {
  return new URLSearchParams(search).get("mock") === "1";
}

export function lanUrl(path = "/m"): string {
  const ip = typeof __HIVE_LAN_IP__ === "string" ? __HIVE_LAN_IP__ : "localhost";
  const port = typeof location !== "undefined" && location.port ? location.port : "5173";
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${ip}:${port}${path}`;
}

const KEY = "hive.humanId";
export function loadHumanId(): string {
  try {
    return localStorage.getItem(KEY) || "andrii";
  } catch {
    return "andrii";
  }
}
export function saveHumanId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // private mode, ignore
  }
}
