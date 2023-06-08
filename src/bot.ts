import { Message } from "wechaty";
import { WechatyInterface, ContactInterface } from "wechaty/impls";
import * as PUPPET from "wechaty-puppet";
import QRCode from "qrcode";
import { logger } from "./utils.js";
import { MJApi, SubmitResult } from "./mj-api.js";
import { Sensitive } from "./sensitive.js";

export class Bot {
  botName: string = "MJ-BOT";
  createTime: number;
  wechaty: WechatyInterface;
  mjApi: MJApi;
  sensitive: Sensitive;

  constructor(wechaty: WechatyInterface, mjApi: MJApi) {
    this.createTime = Date.now();
    this.wechaty = wechaty;
    this.mjApi = mjApi;
    this.sensitive = new Sensitive();
  }

  public async start() {
    this.wechaty
      .on("scan", async (qrcode) => {
        logger.info(
          `Scan qrcode to login: https://wechaty.js.org/qrcode/${encodeURIComponent(
            qrcode
          )}`
        );
        console.log(
          await QRCode.toString(qrcode, { type: "terminal", small: true })
        );
      })
      .on("login", (user) => {
        logger.info("User %s login success", user.name());
        this.botName = user.name();
      })
      .on("message", async (message) => {
        if (message.date().getTime() < this.createTime) {
          return;
        }
        try {
          await this.handle(message);
        } catch (e) {
          logger.error("Handle message error", e);
        }
      });
    await this.wechaty.start();
  }

  private async handle(message: Message) {
    let rawText = message.text();
    const talker = message.talker();
    const room = message.room();
    const type = message.type();
    const talkerName = talker.name();
    const topic = room ? await room.topic() : null;
    const isimg = type == PUPPET.types.Message.Image;
    // 屏蔽自身发送的信息
    if (message.self()) {
        return
    }
    if (this.isNonsense(talker, type, rawText) && (!isimg || (isimg && room))) {
      return;
    }
    if (rawText == "/help") {
      const result = this.getHelpText();
      if (!room) {
        await message.say(result);
      } else {
        await room.say(result);
      }
      return;
    }
    if (
      !isimg &&
      !rawText.startsWith("/imagine ") &&
      !rawText.startsWith("/up ")
    ) {
      return;
    }
    // 判断是否包含URL（图生图）
    const url = this.getStrUrl(rawText);
    if (url) {
        const t = rawText.indexOf("<a");
        const e = rawText.indexOf("</a>");
        const s = rawText.substring(t, e + 4);
        rawText = rawText.replace(s, url);
    }
    if (this.sensitive.hasSensitiveWord(rawText)) {
      if (!room) {
        await message.say(`⚠ 可能包含违禁词, 请检查`);
      } else {
        await room.say(`@${talkerName} \n⚠ 可能包含违禁词, 请检查`);
      }
      return;
    }
    if (!room) {
      logger.info("[%s]: %s", talkerName, rawText);
    } else {
      logger.info("[%s] [%s]: %s", topic, talkerName, rawText);
    }
    // 调用mj绘图
    let result;
    const state = room ? topic + ":" + talkerName : "" + talkerName;
    if (!room && isimg) {
      const file = await message.toFileBox();
      const base64 = await file.toDataURL();
      result = await this.mjApi.submitTask("/submit/describe", {
        state: state,
        base64: base64,
      });
    } else if (rawText.startsWith("/imagine ")) {
      const prompt = rawText.substring(9);
      result = await this.mjApi.submitTask("/submit/imagine", {
        state: state,
        prompt: prompt,
      });
    } else {
      const content = rawText.substring(4);
      result = await this.mjApi.submitTask("/submit/simple-change", {
        state: state,
        content: content,
      });
    }
    if (!result) {
      return;
    }
    let msg;
    if (result.code == 22) {
      msg = room
        ? `@${talkerName} \n⏰ ${result.description}`
        : `⏰ ${result.description}`;
    } else if (result.code != 1) {
      msg = room
        ? `@${talkerName} \n❌ ${result.description}`
        : `❌ ${result.description}`;
    }
    if (msg) {
      if (!room) {
        await message.say(msg);
        logger.info("[%s]: %s", this.botName, rawText);
      } else {
        await room.say(msg);
        logger.info("[%s] [%s]: %s", topic, this.botName, msg);
      }
    }
  }

  private getStrUrl(s: string) {
    var reg = /(http:\/\/|https:\/\/)((\w|=|\?|\.|\/|&|-)+)/g;
    var reg =
      /(https?|http|ftp|file):\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]/g;
    var d = s.match(reg);
    return d && d.length ? d[0] : '';
  }

  private getHelpText(): string {
    return (
      "欢迎使用MJ机器人\n" +
      "------------------------------\n" +
      "🎨 AI绘图命令\n" +
      "输入: /imagine prompt\n" +
      "prompt 即你提的绘画需求\n" +
      "------------------------------\n" +
      "📕 prompt附加参数 \n" +
      "1.解释: 在prompt后携带的参数, 可以使你的绘画更别具一格\n" +
      "2.示例: /imagine prompt --ar 16:9\n" +
      "3.使用: 需要使用--key value, key和value空格隔开, 多个附加参数空格隔开\n" +
      "------------------------------\n" +
      "📗 附加参数列表\n" +
      "1. --v 版本 1,2,3,4,5 默认5, 不可与niji同用\n" +
      "2. --niji 卡通版本 空或5 默认空, 不可与v同用\n" +
      "3. --ar 横纵比 n:n 默认1:1\n" +
      "4. --q 清晰度 .25 .5 1 2 分别代表: 一般,清晰,高清,超高清,默认1\n" +
      "5. --style 风格 (4a,4b,4c)v4可用 (expressive,cute)niji5可用\n" +
      "6. --s 风格化 1-1000 (625-60000)v3"
    );
  }

  private isNonsense(
    talker: ContactInterface,
    messageType: PUPPET.types.Message,
    text: string
  ): boolean {
    return (
      messageType != PUPPET.types.Message.Text ||
      // talker.self() ||
      talker.name() === "微信团队" ||
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      text.includes("收到红包，请在手机上查看") ||
      text.includes("收到转账，请在手机上查看") ||
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg")
    );
  }
}
