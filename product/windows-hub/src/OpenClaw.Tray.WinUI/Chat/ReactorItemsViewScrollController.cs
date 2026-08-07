using Microsoft.UI.Reactor;
using Microsoft.UI.Reactor.Core;
using Microsoft.UI.Reactor.Core.V1Protocol;
using Microsoft.UI.Reactor.Hooks;
using Microsoft.UI.Reactor.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Runtime.CompilerServices;
using WinUIAnnotatedScrollBar = Microsoft.UI.Xaml.Controls.AnnotatedScrollBar;
using WinUIItemsView = Microsoft.UI.Xaml.Controls.ItemsView;
using WinUIScrollView = Microsoft.UI.Xaml.Controls.ScrollView;

namespace OpenClawTray.Chat;

file sealed record ItemsViewVerticalScrollControllerElement(
    Element Child,
    ElementRef<WinUIAnnotatedScrollBar> ScrollBarRef,
    int InitialTailIndex,
    string InitialTailRequestKey) : Element
{
    static ItemsViewVerticalScrollControllerElement() =>
        ControlRegistry.RegisterDecorator<ItemsViewVerticalScrollControllerElement>(
            static () => new ItemsViewVerticalScrollControllerHandler());
}

file sealed class ItemsViewVerticalScrollControllerHandler
    : IDecoratorElementHandler<ItemsViewVerticalScrollControllerElement>
{
    private static readonly ConditionalWeakTable<WinUIItemsView, InitialTailPositioner> Positioners = new();

    public UIElement Mount(MountContext context, ItemsViewVerticalScrollControllerElement element)
    {
        var control = context.MountChild(element.Child);
        if (control is not WinUIItemsView itemsView)
            throw new InvalidOperationException("ItemsView scroll controller binding requires an ItemsView child.");

        context.BindFor(itemsView, element).Reference(
            get: static value => value.ScrollBarRef,
            set: static (value, scrollBar) =>
                ((WinUIItemsView)value).VerticalScrollController = scrollBar?.ScrollController);
        var positioner = new InitialTailPositioner(itemsView);
        Positioners.Add(itemsView, positioner);
        positioner.Request(element.InitialTailIndex, element.InitialTailRequestKey);
        return itemsView;
    }

    public UIElement Update(
        UpdateContext context,
        ItemsViewVerticalScrollControllerElement oldElement,
        ItemsViewVerticalScrollControllerElement newElement,
        UIElement control)
    {
        var updated = context.ReconcileChild(oldElement.Child, newElement.Child, control);
        if (updated is not WinUIItemsView itemsView)
            throw new InvalidOperationException("ItemsView scroll controller binding requires an ItemsView child.");
        if (!string.Equals(oldElement.InitialTailRequestKey, newElement.InitialTailRequestKey, StringComparison.Ordinal)
            && Positioners.TryGetValue(itemsView, out var positioner))
            positioner.Request(newElement.InitialTailIndex, newElement.InitialTailRequestKey);
        else if (Positioners.TryGetValue(itemsView, out var existingPositioner))
            existingPositioner.UpdateTailIndex(newElement.InitialTailIndex);
        return itemsView;
    }

    public V1UnmountDisposition Unmount(UnmountContext context, ItemsViewVerticalScrollControllerElement? element, UIElement control)
    {
        if (control is WinUIItemsView itemsView && Positioners.TryGetValue(itemsView, out var positioner))
        {
            Positioners.Remove(itemsView);
            positioner.Dispose();
        }
        return V1UnmountDisposition.ContinueDefaultTraversal;
    }
}

/// <summary>
/// Pins chat to the latest row on session/history/send only, via ScrollView.ScrollTo.
/// <para>
/// Do not re-enter ItemsView measure via item bring-into-view or sticky bottom anchoring.
/// Those feedback loops LayoutCycle while streaming content grows
/// (openclaw-tray.log 2026-08-07 11:48 and 13:46).
/// </para>
/// </summary>
file sealed class InitialTailPositioner : IDisposable
{
    private readonly WinUIItemsView itemsView;
    private string? _requestKey;
    private int _tailIndex;
    private int _version;
    private bool _valid;
    private WinUIScrollView? _awaitingScrollView;
    private bool _disposed;
    private bool _pinQueued;

    public InitialTailPositioner(WinUIItemsView itemsView)
    {
        this.itemsView = itemsView;
        itemsView.Loaded += OnLoaded;
        itemsView.Unloaded += OnUnloaded;
    }

    public void Request(int tailIndex, string requestKey)
    {
        if (_disposed || string.Equals(_requestKey, requestKey, StringComparison.Ordinal))
            return;
        _requestKey = requestKey;
        _version++;
        CancelAwaitingScrollView();
        _valid = tailIndex >= 0;
        if (!_valid) return;
        _tailIndex = tailIndex;
        if (itemsView.IsLoaded) QueueOneShotPin();
    }

    public void UpdateTailIndex(int tailIndex)
    {
        // Streaming growth: remember index only. Do NOT re-pin or set anchors —
        // sticky follow during stream is what LayoutCycle'd the Hub.
        _tailIndex = tailIndex;
    }

    private void OnLoaded(object sender, RoutedEventArgs args)
    {
        if (_valid) QueueOneShotPin();
    }

    private void QueueOneShotPin()
    {
        if (_disposed || !_valid || !itemsView.IsLoaded || _pinQueued) return;

        if (itemsView.ScrollView is { IsLoaded: false } scrollView)
        {
            _awaitingScrollView = scrollView;
            scrollView.Loaded += OnScrollViewLoaded;
            return;
        }

        _pinQueued = true;
        var version = _version;
        // Low priority: run after the current layout pass completes, never inside it.
        itemsView.DispatcherQueue.TryEnqueue(
            Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,
            () =>
            {
                _pinQueued = false;
                if (_disposed || !_valid || !itemsView.IsLoaded || version != _version)
                    return;
                if (itemsView.ScrollView is not { IsLoaded: true } scrollView)
                {
                    if (itemsView.ScrollView is { } pending)
                    {
                        _awaitingScrollView = pending;
                        pending.Loaded += OnScrollViewLoaded;
                    }
                    return;
                }

                TryScrollToBottom(scrollView);
            });
    }

    private static void TryScrollToBottom(WinUIScrollView scrollView)
    {
        try
        {
            // Absolute offset — no item bring-into-view, no sticky bottom anchoring.
            var maxOffset = Math.Max(0, scrollView.ExtentHeight - scrollView.ViewportHeight);
            scrollView.ScrollTo(
                scrollView.HorizontalOffset,
                maxOffset,
                new ScrollingScrollOptions(
                    ScrollingAnimationMode.Disabled,
                    ScrollingSnapPointsMode.Ignore));
        }
        catch (Exception ex)
        {
            OpenClawTray.Services.Logger.Debug(
                $"[ReactorScroll] one-shot ScrollTo failed: {ex.Message}");
        }
    }

    private void OnScrollViewLoaded(object sender, RoutedEventArgs args)
    {
        if (sender is WinUIScrollView scrollView) scrollView.Loaded -= OnScrollViewLoaded;
        _awaitingScrollView = null;
        QueueOneShotPin();
    }

    private void OnUnloaded(object sender, RoutedEventArgs args)
    {
        _version++;
        CancelAwaitingScrollView();
        _pinQueued = false;
    }

    private void CancelAwaitingScrollView()
    {
        if (_awaitingScrollView is { } scrollView)
        {
            scrollView.Loaded -= OnScrollViewLoaded;
            _awaitingScrollView = null;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _version++;
        CancelAwaitingScrollView();
        _pinQueued = false;
        itemsView.Loaded -= OnLoaded;
        itemsView.Unloaded -= OnUnloaded;
    }
}

internal static class ItemsViewScrollControllerExtensions
{
    public static Element BindVerticalScrollController<T>(
        this ItemsViewElement<T> itemsView,
        ElementRef<WinUIAnnotatedScrollBar> scrollBarRef,
        int initialTailIndex,
        string initialTailRequestKey) =>
        new ItemsViewVerticalScrollControllerElement(itemsView, scrollBarRef, initialTailIndex, initialTailRequestKey);
}
