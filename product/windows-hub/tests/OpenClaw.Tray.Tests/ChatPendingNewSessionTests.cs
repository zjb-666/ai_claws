using OpenClawTray.Chat;

namespace OpenClaw.Tray.Tests;

public sealed class ChatPendingNewSessionTests
{
    [Fact]
    public void AllocateKey_UsesStablePrefix()
    {
        var key = ChatPendingNewSession.AllocateKey();

        Assert.StartsWith(ChatPendingNewSession.KeyPrefix, key, StringComparison.Ordinal);
        Assert.True(ChatPendingNewSession.IsPendingKey(key));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("agent:main:main")]
    [InlineData("local:pending-new")]
    public void IsPendingKey_False_ForNonPending(string? key)
    {
        Assert.False(ChatPendingNewSession.IsPendingKey(key));
    }

    [Fact]
    public void ShouldFallback_False_ForPendingNewKeys()
    {
        Assert.False(ChatLifecycleSelectionPolicy.ShouldFallback(
            ChatPendingNewSession.AllocateKey(),
            pendingSelectedId: null,
            fallbackThreadId: "agent:main:main"));

        Assert.False(ChatLifecycleSelectionPolicy.ShouldFallback(
            "agent:main:stale",
            pendingSelectedId: ChatPendingNewSession.AllocateKey(),
            fallbackThreadId: "agent:main:main"));
    }

    [Fact]
    public void ShouldFallback_StillTrue_ForOrdinaryStaleSelection()
    {
        Assert.True(ChatLifecycleSelectionPolicy.ShouldFallback(
            "agent:main:stale",
            pendingSelectedId: null,
            fallbackThreadId: "agent:main:main"));
    }
}
