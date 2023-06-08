import express, { Request, Response } from "express";
import { WechatyInterface } from 'wechaty/impls';
import { FileBox } from 'file-box';
import { logger, displayMilliseconds } from "./utils.js";
import { config } from "./config.js";
import { HttpsProxyAgent } from "https-proxy-agent"
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import axios from 'axios';
import * as fs from 'fs';

export class SubmitResult {
  code: number;
  description: string;
  result: string = "";

  constructor(code: number, description: string) {
    this.code = code;
    this.description = description;
  }
};

export class MJApi {
  listenerPort: number = 80;
  wechaty: WechatyInterface;
  axiosInstance: AxiosInstance;

  constructor(wechaty: WechatyInterface) {
    this.wechaty = wechaty;
    this.axiosInstance = axios.create({
      baseURL: config.mjProxyEndpoint,
      timeout: 60000
    });
  }

  public async listenerNotify() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.post("/notify", async (req: Request, res: Response): Promise<Response> => {
      return this.handle(req, res);
    });
    app.listen(this.listenerPort, (): void => {
      logger.info("mj listener start success on port %d", this.listenerPort);
    });
  }

  public async submitTask(url: string, params: any): Promise<SubmitResult> {
    const notifyHook = config.notifyHook ? { notifyHook: config.notifyHook } : {};
    try {
      const response = await this.axiosInstance.post(url, { ...params, ...notifyHook });
      if (response.status === 200) {
        return response.data;
      }
      logger.error("submit mj task failed, %d: %s", response.status, response.statusText);
      return new SubmitResult(response.status, response.statusText);
    } catch (e) {
      logger.error("submit mj error", e);
      return new SubmitResult(-9, "MJ服务异常, 请稍后再试");
    }
  }

  private async proxyDownloadImage(url: string): Promise<FileBox> {
    const response: AxiosResponse = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      httpsAgent: new HttpsProxyAgent(config.httpProxy),
      timeout: 10000,
    });
    const filename = url.split('/')!.pop()!;
    if (config.imagesPath != '') {
      fs.writeFileSync(config.imagesPath + '/' + filename, response.data, 'binary');
    }
    const fileBuffer = Buffer.from(response.data, 'binary');
    return FileBox.fromBuffer(fileBuffer, filename);
  }

  private async handle(req: Request, res: Response) {
    try {
      let room;
      const state = req.body.state;
      const i = state.indexOf(":");
      const roomName = i >= 0 ? state.substring(0, i) : '';
      const userName = i >= 0 ? state.substring(i + 1) : state;
      if(!roomName) {
        // 私聊微信号
        room = await this.wechaty.Contact.find({ name: userName });
      } else {
        // 群聊
        room = await this.wechaty.Room.find({ topic: roomName });
      }
      if (!room) {
        return res.status(404).send("room not found");
      }
      const action = req.body.action;
      const status = req.body.status;
      const description = req.body.description;
      const title = roomName ? `@${userName} \n` : '';
      if (status == 'SUBMITTED') {
        room.say(title + `✅ 您的任务已提交\n✨ ${description}\n🚀 正在快速处理中，请稍后`);
      } else if (status == 'FAILURE') {
        room.say(title + `❌ 任务执行失败\n✨ ${description}\n📒 失败原因: ${req.body.failReason}`);
      } else if (status == 'SUCCESS') {
        const time = req.body.finishTime - req.body.submitTime;
        if (action == 'UPSCALE') {
          await room.say(title + `🎨 图片放大成功，用时: ${displayMilliseconds(time)}\n✨ ${description}`);
          let image;
          if (config.httpProxy) {
            image = await this.proxyDownloadImage(req.body.imageUrl);
          } else {
            image = FileBox.fromUrl(req.body.imageUrl);
          }
          room.say(image);
        } else if (action == 'DESCRIBE') {
          const prompt = req.body.prompt;
          const promptEn = req.body.promptEn;
          const imageUrl = req.body.imageUrl;
          await room.say(title + `🎨 获取图片信息成功，用时: ${displayMilliseconds(time)}\n✨ Prompt: ${prompt}\n✨✨ 图片地址: ${imageUrl}`);
        } else {
          const taskId = req.body.id;
          const prompt = req.body.prompt;
          await room.say(title + `🎨 ${action == 'IMAGINE' ? '绘图' : '变换'}成功，用时 ${displayMilliseconds(time)}\n✨ Prompt: ${prompt}\n📨 任务ID: ${taskId}\n🪄 放大 U1～U4，变换 V1～V4\n✏️ 使用[/up 任务ID 操作]\n/up ${taskId} U1`);
          let image;
          if (config.httpProxy) {
            image = await this.proxyDownloadImage(req.body.imageUrl);
          } else {
            image = FileBox.fromUrl(req.body.imageUrl);
          }
          room.say(image);
        }
      }
      return res.status(200).send({ code: 1 });
    } catch (e) {
      logger.error("mj listener handle error", e);
      return res.status(500).send({ code: -9 });
    }
  }
}
