# Control Tower - system tray mode.
#
# Runs the server with no console window at all, and puts a tray icon in its place: double-click
# (or "Open Control Tower") opens the dashboard, "View log" shows what the server has printed since
# it isn't going to a visible console any more, and "Quit" stops the server and removes the icon.
# Launched by start-tray.cmd, which hides this script's own PowerShell window too.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: if this script's own process ever
# goes away for any reason - the Quit handler below, but also a crash or someone ending it from
# Task Manager - Windows itself kills every process assigned to the job, so the server can never
# be orphaned running invisibly. Explicit Stop-Process calls elsewhere are the tidy path; this is
# the guarantee underneath them.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ControlTowerJob : IDisposable {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT { public Int64 a; public Int64 b; public UInt32 LimitFlags; public UIntPtr c; public UIntPtr d; public UInt32 e; public Int64 f; public UInt32 g; public UInt32 h; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public UInt64 a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr i, j, k, l; }
    IntPtr handle;
    public ControlTowerJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        var info = new EXTENDED_LIMIT();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int len = Marshal.SizeOf(typeof(EXTENDED_LIMIT));
        IntPtr ptr = Marshal.AllocHGlobal(len);
        Marshal.StructureToPtr(info, ptr, false);
        SetInformationJobObject(handle, 9, ptr, (uint)len);
        Marshal.FreeHGlobal(ptr);
    }
    public bool AddProcess(IntPtr processHandle) { return AssignProcessToJobObject(handle, processHandle); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}
'@

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$port = if ($env:FLEET_PORT) { $env:FLEET_PORT } else { '7457' }
$url = "http://localhost:$port/"
$logFile = Join-Path $env:TEMP 'control-tower-tray.log'
$nodePath = (Get-Command node -ErrorAction Stop).Source

# The tray icon is how you open the dashboard here, so the server doesn't need to pop a browser
# tab on its own the way start.cmd's console-window mode does.
$env:FLEET_NO_OPEN = '1'

$job = New-Object ControlTowerJob
$serverProc = Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $here `
  -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -PassThru
[void]$job.AddProcess($serverProc.Handle)

$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($nodePath)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open Control Tower')
$logItem = $menu.Items.Add('View log')
[void]$menu.Items.Add('-')
$quitItem = $menu.Items.Add('Quit')

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = 'Control Tower'
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

$openAction = { Start-Process $url }
$openItem.Add_Click($openAction)
$tray.Add_DoubleClick($openAction)
$logItem.Add_Click({
  if (Test-Path $logFile) { Start-Process notepad.exe $logFile }
  else { [System.Windows.Forms.MessageBox]::Show('Nothing logged yet.', 'Control Tower') | Out-Null }
})
$quitItem.Add_Click({
  $tray.Visible = $false
  if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
  [System.Windows.Forms.Application]::Exit()
})

# If the server dies on its own (a crash, the port already in use), the icon shouldn't sit there
# pretending everything's fine.
$watchdog = New-Object System.Windows.Forms.Timer
$watchdog.Interval = 3000
$watchdog.Add_Tick({
  if ($serverProc.HasExited) {
    $watchdog.Stop()
    $tray.ShowBalloonTip(8000, 'Control Tower stopped', 'The server process ended - check View log for why.', [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
$watchdog.Start()

[System.Windows.Forms.Application]::Run()

if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
$tray.Dispose()
$job.Dispose()
