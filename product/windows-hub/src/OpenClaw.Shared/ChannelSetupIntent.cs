using System.Text.RegularExpressions;

namespace OpenClaw.Shared;

/// <summary>
/// Detects chat phrases that should open the official gateway channel-setup
/// wizard (<c>wizard.start { flow: "channels" }</c>) instead of letting the
/// coding agent thrash with tools/CLI guesses.
/// </summary>
public static partial class ChannelSetupIntent
{
    /// <summary>
    /// When true, <paramref name="channelId"/> is a gateway channel id (e.g.
    /// <c>feishu</c>) or <c>null</c> to browse/select a channel in the wizard.
    /// </summary>
    public static bool TryParse(string? text, out string? channelId)
    {
        channelId = null;
        if (string.IsNullOrWhiteSpace(text))
            return false;

        var trimmed = text.Trim();
        // Multi-sentence / long prompts stay with the agent.
        if (trimmed.Length > 80 || trimmed.Contains('\n'))
            return false;

        var normalized = Normalize(trimmed);
        if (normalized.Length == 0)
            return false;

        if (TryMatchKnownChannel(normalized, out channelId))
            return true;

        return IsGenericChannelSetupPhrase(normalized);
    }

    private static bool TryMatchKnownChannel(string normalized, out string? channelId)
    {
        foreach (var entry in ChannelAliases)
        {
            foreach (var alias in entry.Aliases)
            {
                if (!ContainsAlias(normalized, alias))
                    continue;

                if (!HasSetupVerbNearChannel(normalized, alias))
                    continue;

                channelId = entry.ChannelId;
                return true;
            }
        }

        channelId = null;
        return false;
    }

    private static bool ContainsAlias(string normalized, string alias)
    {
        if (alias.Length == 0)
            return false;

        // CJK aliases are substrings; short Latin tokens need word boundaries so
        // "faq" does not match "qq" and "stage" does not match "tg".
        if (alias.Any(c => c > 0x7F))
            return normalized.Contains(alias, StringComparison.Ordinal);

        if (alias.Contains(' ', StringComparison.Ordinal))
            return normalized.Contains(alias, StringComparison.Ordinal);

        var pattern = $@"(?:^|[^a-z0-9]){Regex.Escape(alias)}(?:$|[^a-z0-9])";
        return Regex.IsMatch(normalized, pattern, RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    }

    private static bool HasSetupVerbNearChannel(string normalized, string alias)
    {
        // "feishu status" / "飞书消息" should not open setup.
        if (SetupVerbRegex().IsMatch(normalized))
            return true;

        // Bare "接飞书" / "飞书机器人" style short intents without a Latin verb.
        if (ChineseSetupHintRegex().IsMatch(normalized))
            return true;

        // Exact alias alone is too ambiguous ("telegram"); require a verb or
        // Chinese connect/bot framing already covered above.
        return false;
    }

    private static bool IsGenericChannelSetupPhrase(string normalized) =>
        GenericSetupPhraseRegex().IsMatch(normalized);

    private static string Normalize(string text)
    {
        var lower = text.ToLowerInvariant();
        return WhitespaceRegex().Replace(lower, " ").Trim();
    }

    private static readonly ChannelAliasEntry[] ChannelAliases =
    [
        new("feishu", ["feishu", "lark", "飞书", "larksuite"]),
        new("wecom", ["wecom", "wechatwork", "wechat-work", "企业微信", "企微", "企业微信机器人"]),
        new("qqbot", ["qqbot", "qq bot", "qq机器人", "qq 机器人", "qq"]),
        new("dingtalk", ["dingtalk", "钉钉"]),
        new("telegram", ["telegram", "tg", "电报"]),
        new("discord", ["discord"]),
        new("slack", ["slack"]),
        new("whatsapp", ["whatsapp", "wa"]),
        new("signal", ["signal"]),
        new("googlechat", ["googlechat", "google chat", "google-chat", "谷歌聊天"]),
        new("mattermost", ["mattermost"]),
        new("msteams", ["msteams", "teams", "微软团队", "ms teams"]),
        new("matrix", ["matrix"]),
        new("nostr", ["nostr"]),
        new("imessage", ["imessage", "i message"]),
        new("bluebubbles", ["bluebubbles", "blue bubbles"]),
        new("zalo", ["zalo"]),
        new("line", ["line"]),
    ];

    private sealed record ChannelAliasEntry(string ChannelId, string[] Aliases);

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex(
        @"\b(connect|setup|configure|add|install|link|pair|enable|bind|onboard)\b|(接|连|接入|连接|绑定|配置|开通|添加).{0,12}(机器人|通道|渠道|channel|bot)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex SetupVerbRegex();

    [GeneratedRegex(
        @"(接|连|接入|连接|绑定|配置|开通|添加).{0,8}(飞书|企微|企业微信|钉钉|qq|电报)|((飞书|企微|企业微信|钉钉).{0,6}(机器人|通道|渠道))",
        RegexOptions.CultureInvariant)]
    private static partial Regex ChineseSetupHintRegex();

    [GeneratedRegex(
        @"^(connect|setup|configure|add|install|link)\s+(a\s+)?(channel|bot|messaging)|^(接|接入|连接|绑定|配置|添加)(一个)?(机器人|通道|渠道|channel)$|^(通道|渠道)(设置|配置|接入)$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex GenericSetupPhraseRegex();
}
