import { API, Channel } from "revolt-api";
import Signaling from "./Signaling";
import EventEmitter from "events";
import { Device, useSdesMid, RTCRtpCodecParameters } from "msc-node";
import { RtpCapabilities } from "msc-node/lib/RtpParameters";
import { RevoiceState } from "./VortexTypes";
import { Media } from "./Media";
import { Producer } from "msc-node/lib/Producer";
import { Transport } from "msc-node/lib/Transport";

export class VoiceConnection {
  public eventemitter = new EventEmitter();
  public device: Device;
  public signaling: Signaling;
  public leaveTimeout: boolean;
  public media = null;
  public state: RevoiceState;
  public producer: Producer;
  public leaving: NodeJS.Timeout;
  public sendTransport: Transport;

  constructor(
    public channelId: string,
    public voice: Revoice,
    opts: { device: Device; signaling: Signaling; leaveOnEmpty: boolean }
  ) {
    this.setupSignaling();
    this.signaling.connect(channelId);

    this.leaveTimeout = opts.leaveOnEmpty;
  }
  on(event: string, cb: any) {
    return this.eventemitter.on(event, cb);
  }
  once(event: string, cb: any) {
    return this.eventemitter.once(event, cb);
  }
  emit(event: string, data?: any) {
    return this.eventemitter.emit(event, data);
  }

  updateState(state: RevoiceState) {
    this.state = state;
    this.emit("state", state);
  }

  getUsers() {
    return this.signaling.users;
  }
  isConnected(userId: string) {
    return this.signaling.isConnected(userId);
  }

  setupSignaling() {
    const signaling = this.signaling;
    signaling.on("token", () => {});
    signaling.on("authenticate", (data: { data: { rtpCapabilities: RtpCapabilities } }) => {
      this.device.load({ routerRtpCapabilities: data.data.rtpCapabilities });
    });
    signaling.on("initTransports", (data) => {
      this.initTransports(data);
    });

    // user events
    signaling.on("roomfetched", () => {
      this.initLeave();
      signaling.users.forEach((user) => {
        this.voice.users.set(user.id, user);
      });
    });
    signaling.on("userjoin", (user) => {
      this.voice.users.set(user.id, user);
      if (this.leaving) {
        clearTimeout(this.leaving);
        this.leaving = null;
      }
      this.emit("userjoin", user);
    });
    signaling.on("userleave", (user) => {
      const old = this.voice.users.get(user.id);
      old.connected = false;
      old.connectedTo = null;
      this.voice.users.set(user.id, old);
      this.initLeave();
      this.emit("userleave", user);
    });
  }
  initLeave() {
    const signaling = this.signaling;
    if (this.leaving) {
      clearTimeout(this.leaving);
      this.leaving = null;
    }
    if (!(signaling.roomEmpty && this.leaveTimeout)) return;
    this.leaving = setTimeout(
      () => {
        this.once("leave", () => {
          this.destroy();
          this.emit("autoleave");
        });
        this.leave();
      },
      this.leaveTimeout ? 1000 : 0
    );
  }
  initTransports(data) {
    this.sendTransport = this.device.createSendTransport({ ...data.data.sendTransport });
    this.sendTransport.on("connect", ({ dtlsParameters }, callback) => {
      this.signaling.connectTransport(this.sendTransport.id, dtlsParameters).then(callback);
    });
    this.sendTransport.on("produce", (parameters, callback) => {
      this.signaling.startProduce("audio", parameters.rtpParameters).then((cid) => {
        callback({ cid });
      });
    });

    this.updateState(RevoiceState.IDLE);
    this.emit("join");
  }
  async play(media: Media) {
    this.updateState(!media.isMediaPlayer ? RevoiceState.UNKNOWN : RevoiceState.BUFFERING);

    media.on("finish", () => {
      this.signaling.stopProduce();
      this.producer.close();
      this.updateState(RevoiceState.IDLE);
    });
    media.on("buffer", (producer: Producer) => {
      this.producer = producer;
      this.updateState(RevoiceState.BUFFERING);
    });
    media.on("start", () => {
      this.updateState(RevoiceState.PLAYING);
    });
    media.on("pause", () => {
      this.updateState(RevoiceState.PAUSED);
    });
    this.media = media;
    this.media.transport = this.sendTransport;
    return this.producer;
  }
  closeTransport() {
    return new Promise((res) => {
      this.sendTransport.once("close", () => {
        this.sendTransport = undefined;
        res(void 0);
      });
      this.sendTransport.close();
    });
  }
  disconnect() {
    return new Promise((res) => {
      this.signaling.disconnect();
      this.closeTransport().then(() => {
        // just a temporary fix till vortex rewrite
      });
      this.device = Revoice.createDevice();
      res(void 0);
    });
  }
  destroy() {
    return new Promise(async (res) => {
      this.disconnect();
      if (this.media) await this.media.destroy();
      res(void 0);
    });
  }
  async leave() {
    this.updateState(RevoiceState.OFFLINE);
    await this.disconnect();
    if (this.media) this.media.disconnect();
    this.emit("leave");
  }
}

export default class Revoice {
  static createDevice() {
    return new Device({
      headerExtensions: {
        audio: [useSdesMid()],
      },
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            payloadType: 100,
            channels: 2,
          }),
        ],
      },
    });
  }
  static Error = {
    ALREADY_CONNECTED: "acon", // joining failed because already connected to a voice channel in this server
    NOT_A_VC: "novc", // joining failed because the bot is already connected to the channel
    VC_ERROR: "vce", // there was an error fetching data about the voice channel
  };

  public api: API;
  public signals = new Map();
  public signaling: Signaling;
  public eventemitter = new EventEmitter();
  public transports = new Map();
  public devices = new Map(); // list of devices by server id
  public connected = []; // list of channels the bot is connected to
  public connections = new Map();
  public users = new Map();
  public state = RevoiceState.OFFLINE;

  constructor(token: string) {
    this.api = new API({ authentication: { revolt: token } });
    this.signaling = new Signaling(this.api);

    return this;
  }
  updateState(state: RevoiceState) {
    this.state = state;
    this.emit("state", state);
  }
  on(event: string, cb: any) {
    return this.eventemitter.on(event, cb);
  }
  once(event: string, cb: any) {
    return this.eventemitter.once(event, cb);
  }
  emit(event: string, data?: any) {
    return this.eventemitter.emit(event, data);
  }
  static uid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  getUser(id: string) {
    if (!this.users.has(id)) return false; // no data about the user in cache
    const user = this.users.get(id);
    if (!user) return false;
    if (!user.connected) return { user };
    const connection = this.connections.get(user.connectedTo);
    return { user, connection };
  }
  knowsUser(id: string) {
    // might not be up-to-date because of leaving
    return this.users.has(id);
  }

  join(channelId: string, leaveIfEmpty = false) {
    // leaveIfEmpty == amount of seconds the bot will wait before leaving if the room is empty
    return new Promise((res, rej) => {
      this.api
        .get(`/channels/${channelId}`)
        .then((data: Channel) => {
          if (data.channel_type != "VoiceChannel") return rej(Revoice.Error.NOT_A_VC);
          if (this.devices.has(channelId)) {
            return rej(Revoice.Error.ALREADY_CONNECTED);
          }

          const signaling = new Signaling(this.api);
          const device = Revoice.createDevice();

          const connection = new VoiceConnection(channelId, this, {
            signaling: signaling,
            device: device,
            leaveOnEmpty: leaveIfEmpty,
          });
          connection.on("autoleave", () => {
            this.connections.delete(channelId);
          });
          connection.updateState(RevoiceState.JOINING);
          this.connections.set(channelId, connection);
          res(connection);
        })
        .catch((e) => {
          console.log(e);
          rej(Revoice.Error.VC_ERROR);
        });
    });
  }
  getVoiceConnection(channelId: string) {
    return this.connections.get(channelId);
  }
}
