using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using OpenClaw.SetupEngine.UI.Pages;

namespace OpenClaw.SetupEngine.UI;

/// <summary>
/// Hosts the same gateway <c>wizard.start { flow: "channels" }</c> UI used by
/// Control UI, so Hub chat / Channels can complete channel setup without an
/// agent tool loop.
/// </summary>
public sealed partial class ChannelSetupWizardWindow : Window
{
    private static ChannelSetupWizardWindow? s_active;
    private bool _isClosed;
    private bool _completed;

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    public static ChannelSetupWizardWindow? Active =>
        s_active is { _isClosed: false } ? s_active : null;

    public ChannelSetupWizardWindow(string? channelId = null)
    {
        InitializeComponent();
        s_active = this;

        Closed += (_, _) =>
        {
            _isClosed = true;
            if (ReferenceEquals(s_active, this))
                s_active = null;
        };

        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var dpi = GetDpiForWindow(hwnd);
        var scale = dpi / 96.0;
        AppWindow.Resize(new Windows.Graphics.SizeInt32((int)(720 * scale), (int)(820 * scale)));

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleBarDrag);
        SystemBackdrop = new MicaBackdrop();

        var label = string.IsNullOrWhiteSpace(channelId)
            ? "Channel setup"
            : $"Channel setup: {channelId.Trim()}";
        Title = label;
        TitleBarText.Text = label;

        var config = new SetupConfig
        {
            WizardFlow = "channels",
            WizardChannel = string.IsNullOrWhiteSpace(channelId) ? null : channelId.Trim(),
            OnWizardCompleted = () =>
            {
                _completed = true;
                // Close after the UI thread finishes rendering the done state.
                DispatcherQueue.TryEnqueue(() =>
                {
                    if (!_isClosed)
                        Close();
                });
            },
        };

        RootFrame.Navigate(typeof(WizardPage), config);
    }

    /// <summary>
    /// Opens or focuses the channel-setup wizard. One active window at a time
    /// (gateway also allows only one running wizard session).
    /// </summary>
    public static ChannelSetupWizardWindow ShowOrActivate(string? channelId = null)
    {
        if (Active is { } existing)
        {
            existing.Activate();
            return existing;
        }

        var window = new ChannelSetupWizardWindow(channelId);
        window.Activate();
        return window;
    }

    public bool CompletedSuccessfully => _completed;
}
