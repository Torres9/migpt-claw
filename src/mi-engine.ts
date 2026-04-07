import { jsonDecode } from "@mi-gpt/utils/parse";
import { RustServer } from "./mi-rust.js";
import { OpenXiaoAISpeaker } from "./mi-speaker.js";
import { getMiGPTRuntime } from "./runtime.js";
import { randomUUID } from "node:crypto";

class OpenXiaoAIEngine {
  speaker = OpenXiaoAISpeaker;

  async start() {
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
    console.log(`🔥 ${text}`);
    const runtime = getMiGPTRuntime();
    const timestamp = Date.now();
    const msgId = randomUUID();

    // 中断小爱默认回复
    await this.speaker.abortXiaoAI();

    // 记录活动
    runtime.channel.activity.record({
      channel: "migpt",
      accountId: "local",
      direction: "inbound",
    });

    const fromAddress = "migpt:local";
    const toAddress = "migpt:local";
    const sessionKey = "local:device";

    // 构建消息体
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions({});
    const body = runtime.channel.reply.formatInboundEnvelope({
      Body: text,
      BodyForAgent: text,
      From: fromAddress,
      To: toAddress,
      SessionKey: sessionKey,
      ChatType: "direct",
      SenderId: "device",
      SenderName: "device",
      Provider: "migpt",
      Surface: "migpt",
      MessageSid: msgId,
      Timestamp: timestamp,
      OriginatingChannel: "migpt",
      envelopeOptions,
    });

    // 构建上下文
    const ctx = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      From: fromAddress,
      To: toAddress,
      SessionKey: sessionKey,
      AccountId: "local",
      ChatType: "direct",
      SenderId: "device",
      SenderName: "device",
      Provider: "migpt",
      Surface: "migpt",
      MessageSid: msgId,
      Timestamp: timestamp,
      OriginatingChannel: "migpt",
      OriginatingTo: toAddress,
      CommandAuthorized: true,
    });

    // 分派到 OpenClaw，AI 回复通过 SpeakerManager 播放
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: {},
      dispatcherOptions: {
        responsePrefix: "",
        deliver: async (payload, _info) => {
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
