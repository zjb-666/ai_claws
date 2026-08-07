namespace OpenClaw.Tray.Tests;

/// <summary>
/// Source-contract guards: end users must get a visible new-session control
/// (not only the hidden <c>/new</c> slash command) after recoverable agent
/// failures.
/// </summary>
public sealed class ChatNewSessionAffordanceTests
{
    private static string Read(params string[] parts) => File.ReadAllText(Path.Combine(
        new[] { TestRepositoryPaths.GetRepositoryRoot() }.Concat(parts).ToArray()));

    [Fact]
    public void ReactorComposer_ExposesNewSessionToolbarButton()
    {
        var source = Read("src", "OpenClaw.Tray.WinUI", "Chat", "OpenClawReactorChatRoot.cs");

        Assert.Contains("ChatNewSessionButton", source);
        Assert.Contains("ChatPendingNewSession.AllocateKey", source);
        Assert.Contains("OnNewSession", source);
        Assert.Contains("_pendingNewParentSessionKey", source);
    }

    [Fact]
    public void ReactorComposer_CommitsPendingNewOnFirstSend()
    {
        var source = Read("src", "OpenClaw.Tray.WinUI", "Chat", "OpenClawReactorChatRoot.cs");

        Assert.Contains("ChatPendingNewSession.IsPendingKey(threadId)", source);
        Assert.Contains("ChatLifecycleCommandKind.New", source);
        Assert.DoesNotContain("CreateNewSessionAsync(native, threadId, SelectThread)", source);
    }

    [Fact]
    public void ReactorTimeline_OffersNewSessionOnRecoverableErrors()
    {
        var source = Read("src", "OpenClaw.Tray.WinUI", "Chat", "ReactorChatTimeline.cs");

        Assert.Contains("ChatErrorNewSessionButton", source);
        Assert.Contains("SuggestsNewSessionRecovery", source);
    }
}
