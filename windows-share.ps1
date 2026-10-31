# Windows PowerShell 5.1 / .NET Framework. Uses only inbox Windows components.
# Desktop sharing requires IDataTransferManagerInterop and a live HWND/message loop.
# https://learn.microsoft.com/windows/apps/develop/windows-integration/integrate-sharesheet-send
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Runtime
  $runtimeFacade = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'System.Runtime' } | Select-Object -First 1
  if ($null -eq $runtimeFacade) { throw 'System.Runtime facade unavailable' }
  $framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $references = @('System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll',
    $runtimeFacade.Location)
  # WinMD files are compiler metadata, not ordinary CLR assemblies. Passing them
  # through -ReferencedAssemblies makes PowerShell try to load them first.
  $references += @('Windows.Foundation.winmd', 'Windows.Storage.winmd', 'Windows.ApplicationModel.winmd') | ForEach-Object {
    Join-Path "$env:WINDIR\System32\WinMetadata" $_
  }
  $parameters = New-Object System.CodeDom.Compiler.CompilerParameters
  $parameters.GenerateInMemory = $true
  foreach ($reference in $references) { [void]$parameters.ReferencedAssemblies.Add($reference) }
  Add-Type -CompilerParameters $parameters -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Windows.Forms;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

[ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface DshDataTransferInterop {
    IntPtr GetForWindow(IntPtr hwnd, ref Guid iid);
    void ShowShareUIForWindow(IntPtr hwnd);
}
public static class DshWindowsShare {
    // Use WinRT's own async interface; AsTask depends on SDK union metadata
    // that is not installed on ordinary Windows desktops.
    private static T Await<T>(Windows.Foundation.IAsyncOperation<T> operation) {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
            if (timer.ElapsedMilliseconds > 30000) { operation.Cancel(); throw new TimeoutException("share-file-timeout"); }
            System.Threading.Thread.Sleep(10);
        }
        return operation.GetResults();
    }
    public static void Run(string path, bool checkOnly) {
        if (String.IsNullOrWhiteSpace(path) || (!File.Exists(path) && !Directory.Exists(path))) throw new FileNotFoundException("share-file-not-found");
        IStorageItem item = File.Exists(path)
            ? (IStorageItem)Await(StorageFile.GetFileFromPathAsync(Path.GetFullPath(path)))
            : (IStorageItem)Await(StorageFolder.GetFolderFromPathAsync(Path.GetFullPath(path)));
        using (var owner = new Form()) {
            owner.Text = "DSH - Windows Share";
            owner.Width = 390; owner.Height = 140;
            owner.StartPosition = FormStartPosition.CenterScreen;
            owner.FormBorderStyle = FormBorderStyle.FixedDialog;
            owner.MaximizeBox = false; owner.MinimizeBox = false;
            var label = new Label { Text = Path.GetFileName(path), AutoEllipsis = true, Left = 15, Top = 15, Width = 345 };
            var close = new Button { Text = "Close", Left = 270, Top = 55, Width = 90 };
            close.Click += delegate { owner.Close(); };
            owner.Controls.Add(label); owner.Controls.Add(close);
            var interop = (DshDataTransferInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(DataTransferManager));
            var iid = new Guid("A5CAEE9B-8708-49D1-8D36-67D25A8DA00C");
            IntPtr pointer = interop.GetForWindow(owner.Handle, ref iid);
            DataTransferManager manager;
            try { manager = (DataTransferManager)Marshal.GetObjectForIUnknown(pointer); }
            finally { Marshal.Release(pointer); }
            Windows.Foundation.TypedEventHandler<DataTransferManager, DataRequestedEventArgs> requested = delegate(DataTransferManager sender, DataRequestedEventArgs args) {
                try {
                    args.Request.Data.Properties.Title = Path.GetFileName(path);
                    args.Request.Data.SetStorageItems(new IStorageItem[] { item });
                } catch (Exception) { args.Request.FailWithDisplayText("DSH could not prepare this file for sharing."); }
            };
            manager.DataRequested += requested;
            try {
                // CI self-check resolves the actual file, creates an HWND and binds the
                // real WinRT event. It never opens Share UI or sends anything.
                if (checkOnly) { Console.WriteLine("DSH_SHARE_CHECK_OK"); return; }
                owner.Shown += delegate {
                    try {
                        interop.ShowShareUIForWindow(owner.Handle);
                        Console.WriteLine("DSH_SHARE_READY");
                        Console.Out.Flush();
                    } catch (Exception error) {
                        Console.Error.WriteLine("DSH_SHARE_ERROR:" + error.GetType().Name + ":" + error.HResult);
                        owner.Close();
                    }
                };
                using (var expiry = new Timer()) {
                    expiry.Interval = 300000;
                    expiry.Tick += delegate { owner.Close(); };
                    expiry.Start();
                    Application.Run(owner);
                }
            } finally { manager.DataRequested -= requested; }
        }
    }
}
'@
  [DshWindowsShare]::Run($env:DSH_SHARE_PATH, $env:DSH_SHARE_CHECK -eq '1')
} catch {
  [Console]::Error.WriteLine('DSH_SHARE_ERROR:' + $_.Exception.GetType().Name + ':' + $_.Exception.Message)
  exit 1
}
