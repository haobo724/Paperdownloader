import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Locate eduVPN using an explicit override or standard Windows locations. */
export function findEduVpnClient(): string {
  const override = process.env.EDUVPN_CLIENT_PATH;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error("Configured eduVPN client was not found.");
  }
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  const candidates = roots.filter((root): root is string => Boolean(root)).flatMap(root => [
    path.join(root, "eduVPN", "Core", "eduVPN.Client.exe"),
    path.join(root, "Programs", "eduVPN", "Core", "eduVPN.Client.exe"),
  ]);
  const found = candidates.find(candidate => existsSync(candidate));
  if (found) return found;
  throw new Error("eduVPN client not found in standard locations. Set EDUVPN_CLIENT_PATH if needed.");
}

/** Check a configured adapter or an active eduVPN adapter, not just the process. */
async function checkEduVpnAdapter(adapter: string | undefined): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Automatic adapter detection is available on Windows only.");
  const command = "$ErrorActionPreference='Stop'; $target=$env:EDUVPN_ADAPTER_NAME; $a=@(Get-NetAdapter -IncludeHidden | Where-Object { if ($target) { $_.Name -eq $target } else { $_.Name -match '^eduVPN([. -]|$)' } } | Where-Object { $_.Status -eq 'Up' }); if ($a.Count -gt 0) { 'connected' } else { 'disconnected' }";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 15000, windowsHide: true, env: { ...process.env, EDUVPN_ADAPTER_NAME: adapter ?? "" } });
    if (stdout.trim() === "connected") return true;
    if (stdout.trim() === "disconnected") return false;
    throw new Error("unexpected status");
  } catch {
    throw new Error("Could not determine eduVPN connection status.");
  }
}

export async function isEduVpnConnected(): Promise<boolean> {
  if (targetNeedsAdapterMapping()) throw new Error("A named eduVPN server or profile requires EDUVPN_ADAPTER_NAME to verify its connection.");
  return checkEduVpnAdapter(process.env.EDUVPN_ADAPTER_NAME);
}

function targetNeedsAdapterMapping(): boolean {
  return Boolean((process.env.EDUVPN_SERVER_NAME?.trim() || process.env.EDUVPN_PROFILE_NAME?.trim()) && !process.env.EDUVPN_ADAPTER_NAME?.trim());
}

async function isAnyEduVpnConnected(): Promise<boolean> {
  return checkEduVpnAdapter(undefined);
}

/** Conservative guard for common third-party adapter names; it is not exhaustive. */
async function isKnownOtherVpnConnected(): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("VPN adapter detection is available on Windows only.");
  const command = "$ErrorActionPreference='Stop'; $pattern='(?i)(vpn|wireguard|wintun|tap-windows|globalprotect|anyconnect|fortinet|nordlynx|tailscale|zerotier)'; $target=$env:EDUVPN_ADAPTER_NAME; $a=@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' -and $_.Name -notmatch '^eduVPN([. -]|$)' -and (-not $target -or $_.Name -ne $target) -and ($_.Name -match $pattern -or $_.InterfaceDescription -match $pattern) }); if ($a.Count -gt 0) { 'connected' } else { 'disconnected' }";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 15000, windowsHide: true });
    if (stdout.trim() === "connected") return true;
    if (stdout.trim() === "disconnected") return false;
  } catch { /* fail closed below */ }
  throw new Error("Could not check for other VPN adapters.");
}

async function isClientRunning(): Promise<boolean> {
  const query = "if (Get-Process -Name 'eduVPN.Client' -ErrorAction SilentlyContinue) { 'running' } else { 'stopped' }";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], { timeout: 10000, windowsHide: true });
  if (stdout.trim() === "running") return true;
  if (stdout.trim() === "stopped") return false;
  throw new Error("Could not determine whether the eduVPN client is running.");
}

async function startClient(): Promise<void> {
  const clientPath = findEduVpnClient();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(clientPath, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Activate only a safely identified configured profile; never toggle an active connection off. */
async function connectEduVpnWithoutMouse(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windowCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'eduVPN')
$targetServer = $env:EDUVPN_SERVER_NAME
$targetProfile = $env:EDUVPN_PROFILE_NAME
$adapterName = $env:EDUVPN_ADAPTER_NAME
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$entered = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $adapters = @(Get-NetAdapter -IncludeHidden | Where-Object { if ($adapterName) { $_.Name -eq $adapterName } else { $_.Name -match '^eduVPN([. -]|$)' } } | Where-Object { $_.Status -eq 'Up' })
  if ($adapters.Count -gt 0) { exit 0 }
  $otherAdapters = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -match '^eduVPN([. -]|$)' -and $_.Status -eq 'Up' })
  if ($otherAdapters.Count -gt 0) { throw 'An eduVPN tunnel is already active; refusing to switch.' }
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $windowCondition)
  if ($null -ne $win) {
    $items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $profile = $null; $toggles = @(); $servers = @(); $serverVisible = $false
    foreach ($node in $items) {
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $targetServer -and $node.Current.Name -eq $targetServer) { $serverVisible = $true }
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $node.Current.AutomationId -eq 'Profiles') { $profile = $node }
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and $node.Current.IsEnabled) { $servers += $node }
      $toggle = $null
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { $toggles += $toggle }
    }
    if ($null -ne $profile -and $toggles.Count -eq 1) {
      $selection = @($profile.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection())
      $choices = @($profile.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))))
      # A page already open is not proof of a unique server. Require an exact
      # server name or a server selected from a single unambiguous list.
      $serverOk = if ($targetServer) { $serverVisible -or $entered } else { $entered }
      $profileOk = $selection.Count -eq 1 -and $(if ($targetProfile) { $selection[0].Current.Name -eq $targetProfile } else { $choices.Count -eq 1 })
      if ($serverOk -and $profileOk) {
        $adapters = @(Get-NetAdapter -IncludeHidden | Where-Object { if ($adapterName) { $_.Name -eq $adapterName } else { $_.Name -match '^eduVPN([. -]|$)' } } | Where-Object { $_.Status -eq 'Up' })
        if ($adapters.Count -gt 0) { exit 0 }
        $otherAdapters = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -match '^eduVPN([. -]|$)' -and $_.Status -eq 'Up' })
        if ($otherAdapters.Count -gt 0) { throw 'An eduVPN tunnel is already active; refusing to switch.' }
        if ($toggles[0].Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) { $toggles[0].Toggle(); exit 0 }
        if ($toggles[0].Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { exit 0 }
      }
    }
    if ($null -eq $profile -and -not $entered) {
      $candidates = @($servers | Where-Object { if ($targetServer) { $_.Current.Name -eq $targetServer } else { $true } })
      if ($candidates.Count -eq 1) {
        $item = $candidates[0]
        $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        $item.SetFocus()
        if (($item.GetRuntimeId() -join ',') -ne ([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ',')) { throw 'Cannot focus the selected entry safely.' }
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        $entered = $true
      }
    }
  }
  Start-Sleep -Milliseconds 500
}
throw 'No uniquely identifiable server and profile were available. Select them or configure their exact display names.'
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], { timeout: 25000, windowsHide: true });
  } catch {
    throw new Error("Could not safely activate a unique eduVPN profile. Configure exact server/profile names or complete setup in eduVPN.");
  }
}

type VpnOps = {
  isConnected: () => Promise<boolean>;
  isAnyConnected: () => Promise<boolean>;
  isOtherVpnConnected: () => Promise<boolean>;
  isClientRunning: () => Promise<boolean>;
  startClient: () => Promise<void>;
  connectWithoutMouse: () => Promise<void>;
  delay: (ms: number) => Promise<void>;
};
const defaultOps: VpnOps = { isConnected: isEduVpnConnected, isAnyConnected: isAnyEduVpnConnected, isOtherVpnConnected: isKnownOtherVpnConnected, isClientRunning, startClient, connectWithoutMouse: connectEduVpnWithoutMouse, delay: ms => new Promise(resolve => setTimeout(resolve, ms)) };
let connecting: Promise<void> | undefined;

export type VpnStatus = {
  mode: "auto" | "none" | "eduvpn" | "external";
  status: "connected" | "disabled" | "not_found" | "unavailable";
  detail?: string;
};

export function parseCommandArgs(value: string | undefined): string[] {
  if (!value) return [];
  let result: unknown;
  try { result = JSON.parse(value); } catch { throw new Error("VPN command arguments must be a JSON array of strings."); }
  if (!Array.isArray(result) || result.some(x => typeof x !== "string")) throw new Error("VPN command arguments must be a JSON array of strings.");
  return result;
}

/** An external status executable must return 0 when connected and 1 when disconnected. */
export async function isExternalVpnConnected(): Promise<boolean> {
  const executable = process.env.VPN_STATUS_EXECUTABLE?.trim();
  if (!executable) throw new Error("A VPN status executable must be configured for external mode.");
  const args = parseCommandArgs(process.env.VPN_STATUS_ARGS_JSON);
  try {
    await execFileAsync(executable, args, { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
    throw new Error("External VPN status check failed or returned an unknown status.");
  }
}

async function connectExternalVpn(): Promise<void> {
  const executable = process.env.VPN_CONNECT_EXECUTABLE?.trim();
  if (!executable) throw new Error("No external VPN connection executable is configured.");
  const args = parseCommandArgs(process.env.VPN_CONNECT_ARGS_JSON);
  try {
    await execFileAsync(executable, args, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error("External VPN connection command failed.");
  }
}

type VpnDetectionOps = {
  platform: string;
  isConnected: () => Promise<boolean>;
  findClient: () => string;
  ensure: () => Promise<void>;
  isExternalConnected: () => Promise<boolean>;
  connectExternal: () => Promise<void>;
  delay: (ms: number) => Promise<void>;
};
const defaultDetectionOps: VpnDetectionOps = { platform: process.platform, isConnected: isEduVpnConnected, findClient: findEduVpnClient, ensure: ensureEduVpnConnected, isExternalConnected: isExternalVpnConnected, connectExternal: connectExternalVpn, delay: ms => new Promise(resolve => setTimeout(resolve, ms)) };
let externalConnecting: Promise<VpnStatus> | undefined;

/** A legacy provider-specific strict mode remains an alias without encoding a provider. */
export function normalizeVpnMode(value: string | undefined): VpnStatus['mode'] {
  const mode = (value ?? "auto").trim().toLowerCase() || "auto";
  if (/^[a-z0-9]+-eduvpn$/.test(mode)) return "eduvpn";
  if (mode === "auto" || mode === "none" || mode === "eduvpn" || mode === "external") return mode;
  throw new Error("Unsupported VPN_MODE. Use auto, none, eduvpn, or external.");
}

async function checkExternal(ops: VpnDetectionOps): Promise<VpnStatus> {
  if (!process.env.VPN_STATUS_EXECUTABLE?.trim()) return { mode: "external", status: "unavailable", detail: "Configure a status executable for the external VPN." };
  try {
    if (await ops.isExternalConnected()) return { mode: "external", status: "connected" };
  } catch {
    return { mode: "external", status: "unavailable", detail: "External VPN status could not be determined; connection was not attempted." };
  }
  if (!process.env.VPN_CONNECT_EXECUTABLE?.trim()) return { mode: "external", status: "unavailable", detail: "External VPN is disconnected; connect it or configure a connection executable." };
  try {
    await ops.connectExternal();
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await ops.isExternalConnected()) return { mode: "external", status: "connected" };
      await ops.delay(1000);
    }
  } catch {
    return { mode: "external", status: "unavailable", detail: "External VPN connection or subsequent status check failed." };
  }
  return { mode: "external", status: "unavailable", detail: "External VPN did not become connected." };
}

/** Default eduVPN detection is non-blocking. External VPN connection is explicit opt-in. */
export async function ensureConfiguredVpn(ops: VpnDetectionOps = defaultDetectionOps): Promise<VpnStatus> {
  const mode = normalizeVpnMode(process.env.VPN_MODE);
  if (mode === "none") return { mode, status: "disabled" };
  if (mode === "external") {
    if (ops !== defaultDetectionOps) return checkExternal(ops);
    if (!externalConnecting) externalConnecting = checkExternal(ops).finally(() => { externalConnecting = undefined; });
    return externalConnecting;
  }
  if (ops.platform !== "win32") {
    if (mode === "eduvpn") throw new Error("Automatic eduVPN detection is available on Windows only.");
    return { mode, status: "unavailable", detail: "Automatic eduVPN detection is available on Windows only." };
  }
  if (targetNeedsAdapterMapping()) {
    if (mode === "eduvpn") throw new Error("A named eduVPN server or profile requires EDUVPN_ADAPTER_NAME to verify its connection.");
    return { mode, status: "unavailable", detail: "A named eduVPN server or profile requires EDUVPN_ADAPTER_NAME to verify its connection." };
  }
  if (mode === "eduvpn") {
    await ops.ensure();
    return { mode, status: "connected" };
  }
  try {
    if (await ops.isConnected()) return { mode, status: "connected" };
  } catch {
    return { mode, status: "unavailable", detail: "Could not check the eduVPN connection." };
  }
  try { ops.findClient(); } catch { return { mode, status: "not_found", detail: "eduVPN client was not found in configured or standard locations." }; }
  try {
    await ops.ensure();
    return { mode, status: "connected" };
  } catch {
    return { mode, status: "unavailable", detail: "eduVPN was detected but a connection could not be safely established. Check its configuration and authentication." };
  }
}

export async function ensureEduVpnConnected(ops: VpnOps = defaultOps): Promise<void> {
  if (ops !== defaultOps) return connectAndVerify(ops);
  if (!connecting) connecting = connectAndVerify(ops).finally(() => { connecting = undefined; });
  return connecting;
}

async function connectAndVerify(ops: VpnOps): Promise<void> {
  if (await ops.isConnected()) return;
  if (await ops.isAnyConnected()) throw new Error("Another eduVPN tunnel is already active; refusing to switch connections.");
  if (await ops.isOtherVpnConnected()) throw new Error("Another VPN-like adapter is active; refusing to start eduVPN.");
  if (!await ops.isClientRunning()) await ops.startClient();
  try { await ops.connectWithoutMouse(); } catch {
    if (await ops.isConnected()) return;
    throw new Error("Could not automatically connect eduVPN. Check its configuration and complete any required authentication.");
  }
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await ops.isConnected()) return;
    await ops.delay(1000);
  }
  throw new Error("eduVPN did not connect. Complete any required authentication or verification, then retry.");
}
