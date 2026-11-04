import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Locate eduVPN using an explicit override or standard Windows install locations. */
export function findEduVpnClient(): string {
  const override = process.env.EDUVPN_CLIENT_PATH;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`EDUVPN_CLIENT_PATH does not exist: ${override}`);
  }
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  const candidates = roots.filter((root): root is string => Boolean(root)).flatMap(root => [
    path.join(root, "eduVPN", "Core", "eduVPN.Client.exe"),
    path.join(root, "Programs", "eduVPN", "Core", "eduVPN.Client.exe"),
  ]);
  const found = candidates.find(candidate => existsSync(candidate));
  if (found) return found;
  throw new Error("eduVPN client not found in standard locations. Set EDUVPN_CLIENT_PATH to the full path of eduVPN.Client.exe.");
}

/** Check the actual FAU tunnel, not merely whether the eduVPN process is running. */
export async function isFauVpnConnected(): Promise<boolean> {
  if (process.platform !== "win32") {
    throw new Error("FAU eduVPN status checking currently supports Windows only.");
  }
  const command = "$ErrorActionPreference = 'Stop'; $a = Get-NetAdapter -IncludeHidden -Name 'eduvpn.fau.de' -ErrorAction SilentlyContinue; if ($null -ne $a -and $a.Status -eq 'Up') { 'connected' } else { 'disconnected' }";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 15000, windowsHide: true });
    const status = stdout.trim();
    if (status === "connected") return true;
    if (status === "disconnected") return false;
    throw new Error("unexpected status response");
  } catch (error) {
    throw new Error(`Could not determine FAU eduVPN connection status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function isClientRunning(): Promise<boolean> {
  const processQuery = "if (Get-Process -Name 'eduVPN.Client' -ErrorAction SilentlyContinue) { 'running' } else { 'stopped' }";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processQuery], { timeout: 10000, windowsHide: true });
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

/** Use the saved FAU entry without moving the mouse. This requires an interactive desktop. */
async function connectFauWithoutMouse(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windowCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'eduVPN')
$deadline = [DateTime]::UtcNow.AddSeconds(12)
while ([DateTime]::UtcNow -lt $deadline) {
  $adapter = Get-NetAdapter -IncludeHidden -Name 'eduvpn.fau.de' -ErrorAction SilentlyContinue
  if ($null -ne $adapter -and $adapter.Status -eq 'Up') { exit 0 }
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $windowCondition)
  if ($null -ne $win) {
    $items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    # The client can already be on FAU's profile page instead of the server list.
    $isFauPage = $false
    $profile = $null
    $toggles = @()
    foreach ($node in $items) {
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $node.Current.Name -like 'FAU Friedrich-Alexander-Universität Erlangen-Nürnberg*') { $isFauPage = $true }
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $node.Current.AutomationId -eq 'Profiles') { $profile = $node }
      $toggle = $null
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { $toggles += $toggle }
    }
    if ($isFauPage -and $null -ne $profile -and $toggles.Count -eq 1) {
      $selection = $profile.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
      if (@($selection).Count -eq 1 -and $selection[0].Current.Name -like '*FAU*') {
        $adapter = Get-NetAdapter -IncludeHidden -Name 'eduvpn.fau.de' -ErrorAction SilentlyContinue
        if ($null -ne $adapter -and $adapter.Status -eq 'Up') { exit 0 }
        if ($toggles[0].Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) { $toggles[0].Toggle(); exit 0 }
        if ($toggles[0].Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { exit 0 }
      }
    }
    foreach ($item in $items) {
      if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and
          $item.Current.Name -like 'FAU Friedrich-Alexander-Universität Erlangen-Nürnberg*' -and $item.Current.IsEnabled) {
        $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        $item.SetFocus()
        if (($item.GetRuntimeId() -join ',') -ne ([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ',')) {
          throw 'Cannot focus the FAU entry safely.'
        }
        $adapter = Get-NetAdapter -IncludeHidden -Name 'eduvpn.fau.de' -ErrorAction SilentlyContinue
        if ($null -ne $adapter -and $adapter.Status -eq 'Up') { exit 0 }
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 500
}
throw 'FAU entry was not available on an interactive eduVPN desktop. Authentication or manual setup may be required.'
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], { timeout: 25000, windowsHide: true });
  } catch {
    throw new Error("FAU entry could not be activated; check the eduVPN window and authentication state");
  }
}

type VpnOps = {
  isFauVpnConnected: () => Promise<boolean>;
  isClientRunning: () => Promise<boolean>;
  startClient: () => Promise<void>;
  connectFauWithoutMouse: () => Promise<void>;
  delay: (ms: number) => Promise<void>;
};

const defaultOps: VpnOps = { isFauVpnConnected, isClientRunning, startClient, connectFauWithoutMouse, delay: ms => new Promise(resolve => setTimeout(resolve, ms)) };

let connecting: Promise<void> | undefined;

export type VpnStatus = {
  mode: "auto" | "none" | "fau-eduvpn";
  status: "connected" | "disabled" | "not_found" | "unavailable";
  detail?: string;
};

type VpnDetectionOps = {
  platform: string;
  isConnected: () => Promise<boolean>;
  findClient: () => string;
  ensure: () => Promise<void>;
};

/** Detect and connect eduVPN by default without making it a download requirement. */
export async function ensureConfiguredVpn(ops: VpnDetectionOps = { platform: process.platform, isConnected: isFauVpnConnected, findClient: findEduVpnClient, ensure: ensureFauVpnConnected }): Promise<VpnStatus> {
  const rawMode = (process.env.VPN_MODE ?? "auto").trim().toLowerCase() || "auto";
  if (rawMode !== "auto" && rawMode !== "none" && rawMode !== "fau-eduvpn") {
    throw new Error(`Unsupported VPN_MODE: ${rawMode}. Use auto, none, or fau-eduvpn.`);
  }
  const mode = rawMode;
  if (mode === "none") return { mode, status: "disabled" };
  if (mode === "fau-eduvpn") {
    await ops.ensure();
    return { mode, status: "connected" };
  }
  if (ops.platform !== "win32") return { mode, status: "unavailable", detail: "Automatic eduVPN detection is available on Windows only." };
  try {
    if (await ops.isConnected()) return { mode, status: "connected" };
  } catch {
    return { mode, status: "unavailable", detail: "Could not check the eduVPN connection." };
  }
  try {
    ops.findClient();
  } catch {
    return { mode, status: "not_found", detail: "eduVPN client was not found in configured or standard locations." };
  }
  try {
    await ops.ensure();
    return { mode, status: "connected" };
  } catch {
    return { mode, status: "unavailable", detail: "eduVPN was detected but the FAU connection could not be established." };
  }
}
/** Coalesce simultaneous download requests so they cannot send Enter twice. */
export async function ensureFauVpnConnected(ops: VpnOps = defaultOps): Promise<void> {
  if (ops !== defaultOps) return connectAndVerify(ops);
  if (!connecting) connecting = connectAndVerify(ops).finally(() => { connecting = undefined; });
  return connecting;
}

/** Reuse an active tunnel, or request a connection and verify it becomes active. */
async function connectAndVerify(ops: VpnOps): Promise<void> {
  if (await ops.isFauVpnConnected()) return;
  if (!await ops.isClientRunning()) await ops.startClient();
  try {
    await ops.connectFauWithoutMouse();
  } catch (error) {
    if (await ops.isFauVpnConnected()) return;
    throw new Error(`Could not automatically connect FAU eduVPN: ${error instanceof Error ? error.message : String(error)}. Use an interactive desktop and complete any required authentication, then retry.`);
  }
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await ops.isFauVpnConnected()) return;
    await ops.delay(1000);
  }
  throw new Error("FAU eduVPN did not connect. Complete any required authentication or verification in eduVPN, then retry.");
}
