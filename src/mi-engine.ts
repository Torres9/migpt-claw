import { jsonDecode } from "@mi-gpt/utils/parse";
import { RustServer } from "./mi-rust.js";
import { OpenXiaoAISpeaker } from "./mi-speaker.js";
import { getMiGPTRuntime } from "./runtime.js";
import { randomUUID } from "node:crypto";

interface GatewayContext {
  account: any;
  cfg: any;
  log?: any;
}

const DEFAULT_SPEAKER_PROMPT = `【音箱播报规范 - 必须遵守】
你是一个智能音箱助手，通过语音与用户交流。请遵守以下规范：

📢 播报原则：
1. 简短优先：单次播报控制在 100 字以内，超过请拆分或改用其他渠道
2. 纯文字：只输出适合语音播报的纯文字，不要包含 URL、代码、复杂格式
3. 自然口语：使用简短、清晰的口语表达，避免长句和复杂结构

🚫 不适合播报的内容（应改用其他渠道）：
- 代码片段、技术文档
- 长篇文章、报告（>300 字）
- 复杂数据表格、列表
- 图片、视频、文件等多媒体内容
- URL 链接、邮箱地址

✅ 正确做法示例：
- 短回复："好的，已为你设置明天早上 8 点的闹钟"
- 长内容分流："由于内容较长，详细报告已发送到你的手机/微信，请查看"
- 代码场景："代码已生成并发送到你的邮箱，请注意查收"
- 多媒体场景："这张图片很有趣，已发送到你的手机查看"`;

class OpenXiaoAIEngine {
  speaker = OpenXiaoAISpeaker;
  private gatewayCtx: GatewayContext | null = null;

  async start(ctx: GatewayContext) {
    this.gatewayCtx = ctx;
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 启动服务
    console.log("✅ 服务已启动...");
    await RustServer.start();
  }

  /**
   * 收到事件
   */
  onEvent = (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "playing") {
      // 更新播放状态
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
    } else if (e.event === "instruction" && e.data.NewLine) {
      // 收到语音识别结果
      const line = jsonDecode(e.data.NewLine);
      if (
        line?.header?.namespace === "SpeechRecognizer" &&
        line?.header?.name === "RecognizeResult" &&
        line?.payload?.is_final &&
        line?.payload?.results?.[0]?.text
      ) {
        const text = line.payload.results[0].text;
        this.dispatchToOpenClaw(text);
      }
    } else if (e.event === "kws") {
      const keyword = e.data;
      console.log("🔥 唤醒词识别", keyword);
    }
  };

  /**
   * 将用户消息分派到 OpenClaw，AI 回复通过 SpeakerManager 播放
   */
  private async dispatchToOpenClaw(text: string) {
    const { account, cfg, log } = this.gatewayCtx!;
    const deviceName = account.name ?? account.accountId;
    const timestamp = Date.now();
    const msgId = randomUUID();

    log?.info(`[migpt:${account.accountId}] Received message: ${text.slice(0, 50)}...`);

    // ============ 收到消息时回复收到 ============
    const acknowledgeOnReceive = account.config.acknowledgeOnReceive
      ?? cfg.channels?.migpt?.acknowledgeOnReceive ?? false;

    if (acknowledgeOnReceive) {
      const receiveMessage = account.config.receiveMessage
        ?? cfg.channels?.migpt?.receiveMessage
        ?? '收到，处理中';

      try {
        this.speaker.stop();
        await this.speaker.play({ text: receiveMessage });
      } catch (err) {
        log?.error(`[migpt:${account.accountId}] Failed to play receive message: ${err}`);
      }
    }

    // 记录活动
    const runtime = getMiGPTRuntime();
    runtime.channel.activity.record({
      channel: "migpt",
      accountId: account.accountId,
      direction: "inbound",
    });

    // 构建路由
    const fromAddress = `migpt:${deviceName}`;
    const toAddress = `migpt:${account.accountId}`;
    const sessionKey = `${account.accountId}:${deviceName}`;

    // ============ 系统提示词注入 ============
    const systemPrompts: string[] = [];

    if (account.config.systemPrompt) {
      systemPrompts.push(account.config.systemPrompt);
    }

    const globalSystemPrompt = cfg.channels?.migpt?.systemPrompt;
    if (globalSystemPrompt && globalSystemPrompt !== account.config.systemPrompt) {
      systemPrompts.push(globalSystemPrompt);
    }

    // 构建消息体
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = runtime.channel.reply.formatInboundEnvelope({
      Body: text,
      BodyForAgent: text,
      From: fromAddress,
      To: toAddress,
      SessionKey: sessionKey,
      ChatType: "direct",
      SenderId: deviceName,
      SenderName: deviceName,
      Provider: "migpt",
      Surface: "migpt",
      MessageSid: msgId,
      Timestamp: timestamp,
      OriginatingChannel: "migpt",
      envelopeOptions,
    });

    // 构建 AI 看到的完整上下文
    const contextInfo = `你正在通过小米音箱与用户对话。

【会话上下文】
- 设备：${deviceName}
- 用户：${deviceName}
- 消息 ID: ${msgId}
- 当前时间：${new Date(timestamp).toLocaleString('zh-CN')}`;

    const agentBody = systemPrompts.length > 0
      ? `${contextInfo}\n\n${systemPrompts.join("\n\n")}\n\n${text}`
      : `${contextInfo}\n\n${DEFAULT_SPEAKER_PROMPT}\n\n${text}`;

    // 构建上下文
    const ctx = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: agentBody,
      RawBody: text,
      CommandBody: text,
      From: fromAddress,
      To: toAddress,
      SessionKey: sessionKey,
      AccountId: account.accountId,
      ChatType: "direct",
      SenderId: deviceName,
      SenderName: deviceName,
      Provider: "migpt",
      Surface: "migpt",
      MessageSid: msgId,
      Timestamp: timestamp,
      OriginatingChannel: "migpt",
      OriginatingTo: toAddress,
      CommandAuthorized: true,
    });

    // 分派消息到 OpenClaw
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: "",
        deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
          log?.info(`[migpt:${account.accountId}] deliver called, kind: ${info.kind}`);
          if (payload.text) {
            console.log(`🔊 ${payload.text}`);
            await this.speaker.play({ text: payload.text, blocking: true });
          }
        },
      },
    });
  }

  /**
   * 收到录音音频流
   */
  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
