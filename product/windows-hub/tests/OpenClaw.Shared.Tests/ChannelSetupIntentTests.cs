using OpenClaw.Shared;

namespace OpenClaw.Shared.Tests;

public class ChannelSetupIntentTests
{
    [Theory]
    [InlineData("接飞书", "feishu")]
    [InlineData("连接飞书机器人", "feishu")]
    [InlineData("setup feishu", "feishu")]
    [InlineData("connect lark", "feishu")]
    [InlineData("接企微", "wecom")]
    [InlineData("配置企业微信", "wecom")]
    [InlineData("add telegram bot", "telegram")]
    [InlineData("connect discord", "discord")]
    [InlineData("接入钉钉", "dingtalk")]
    public void TryParse_KnownChannelSetup_ReturnsChannelId(string text, string expected)
    {
        Assert.True(ChannelSetupIntent.TryParse(text, out var channelId));
        Assert.Equal(expected, channelId);
    }

    [Theory]
    [InlineData("连接通道")]
    [InlineData("setup channel")]
    [InlineData("添加机器人")]
    [InlineData("connect a bot")]
    public void TryParse_GenericSetup_ReturnsNullChannel(string text)
    {
        Assert.True(ChannelSetupIntent.TryParse(text, out var channelId));
        Assert.Null(channelId);
    }

    [Theory]
    [InlineData("飞书消息怎么发")]
    [InlineData("what is feishu status")]
    [InlineData("configure faq quietly")]
    [InlineData("hello")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("请帮我详细分析一下飞书的开放平台权限模型，并对比企微的差异，给出迁移方案")]
    public void TryParse_NonSetup_ReturnsFalse(string? text)
    {
        Assert.False(ChannelSetupIntent.TryParse(text, out _));
    }
}
