import EventEmitter from "events";
import { RtpCapabilities } from "msc-node/lib/RtpParameters";
import { API } from "revolt-api";
import { WebSocket } from "ws";
import User from "./User.js";
import { VortexPacketType } from "./VortexTypes.js";

export default class Signaling {
  public eventemitter = new EventEmitter();
  public currId = -1;
  public reconnecting = false;
  public users: User[] = [];
  public roomEmpty = null;
  public ws: WebSocket;

  constructor(public client: API, public channelId?: string, public reconnectTimeout = 3000) {
    this.eventemitter.setMaxListeners(Infinity);
    return this;
  }
  emit(event: string, cb?: any) {
    return this.eventemitter.emit(event, cb);
  }
  on(event: string, cb: any) {
    return this.eventemitter.on(event, cb);
  }
  once(event: string, cb: any) {
    return this.eventemitter.once(event, cb);
  }

  authenticate() {
    // start the authentication and join flow
    this.client.post(`/channels/${this.channelId}/join_call`).then((data: { token: string }) => {
      this.emit("token", data);
      this.initWebSocket(data);
    });
  }
  connect(channel: string) {
    if (this.ws) this.disconnect();
    this.channelId = channel;
    this.authenticate();
  }
  disconnect() {
    this.ws.close(1000);
    this.currId = -1;
  }
  reconnect() {
    this.reconnecting = true;
    this.connect(this.channelId);
  }

  initWebSocket(data: { token: string }) {
    this.ws = new WebSocket("wss://vortex.revolt.chat"); // might need to whitelist this in your antivirus
    this.ws.on("open", () => {
      // Send Authentication when the socket is ready
      const msg = JSON.stringify({
        id: ++this.currId,
        type: "Authenticate",
        data: {
          token: data.token,
          roomId: this.channelId,
        },
      });
      this.ws.send(msg);
    });
    this.ws.on("close", (e) => {
      if (e === 1000) return; // don't reconnect when websocket is closed intentionally
      console.log("WebSocket Closed: ", e);
      // TODO: Reconnect
      setTimeout(() => {
        this.reconnect();
      }, this.reconnectTimeout);
    });
    this.ws.on("error", (e) => {
      console.log("Signaling error: ", e);
    });
    this.ws.on("message", (msg: Buffer) => {
      const data = JSON.parse(Buffer.from(msg).toString()); // convert the received buffer to an object
      this.processWS(data);
    });
  }
  processWS(data: {
    type: VortexPacketType;
    data?: { id?: string; rtpCapabilities?: RtpCapabilities };
  }) {
    // data == parsed websocket message
    switch (data.type) {
      case "InitializeTransports":
        if (!this.reconnecting) this.eventemitter.emit("initTransports", data);
        this.fetchRoomInfo().then(() => {
          this.roomEmpty = this.users.length == 1;
          this.emit("roomfetched");
        });
        break;
      case "Authenticate":
        // continue in signaling process
        if (!this.reconnecting) this.eventemitter.emit("authenticate", data);
        const request = {
          id: ++this.currId,
          type: "InitializeTransports",
          data: {
            mode: "SplitWebRTC",
            rtpCapabilities: data.data.rtpCapabilities,
          },
        };
        this.ws.send(JSON.stringify(request));
        break;
      case "ConnectTransport":
        if (!this.reconnecting) this.eventemitter.emit("ConnectTransport", data);
        break;
      case "StartProduce":
        this.eventemitter.emit("StartProduce", data);
        break;
      case "StopProduce":
        this.eventemitter.emit("StopProduce", data);
        break;
      case "UserJoined":
        const user = new User(data.data.id, this.client);
        user.connected = true;
        user.connectedTo = this.channelId;
        user.once("ready", () => {
          this.addUser(user);
          this.emit("userjoin", user);
        });
        break;
      case "RoomInfo":
        this.emit("roominfo", data);
        break;
      case "UserLeft":
        const id = data.data.id;
        const removed = this.removeUser(id);
        this.roomEmpty = this.users.length == 1;
        this.emit("userleave", removed);
      default:
        // events like startProduce or UserJoined; will be implemented later
        this.eventemitter.emit("data", data);
        // console.log("(yet) Unimplemented case: ", data);
        break;
    }
  }
  addUser(user: User) {
    if (!user) throw "User cannot be null! [Signaling.addUser(user)]";
    this.users.push(user);
  }
  removeUser(id: string) {
    const idx = this.users.findIndex((el) => el.id == id);
    if (idx == -1) return;
    const removed = this.users[idx];
    this.users.splice(idx, 1);
    return removed;
  }
  isConnected(userId: string) {
    // check wether a user is in the voice channel
    const idx = this.users.findIndex((el) => el.id == userId);
    if (idx == -1) return false;
    return true;
  }
  fetchRoomInfo() {
    return new Promise((res) => {
      const request = {
        id: ++this.currId,
        type: "RoomInfo",
      };
      this.ws.send(JSON.stringify(request));
      this.on("roominfo", (data: { data: { users: { [key: string]: { audio: boolean } } } }) => {
        const users = data.data.users;
        //if ((Object.keys(users).length - 1) == 0) return res();
        let promises = [];
        for (let userId in users) {
          const user = new User(userId, this.client);
          user.connected = true;
          user.connectedTo = this.channelId;
          promises.push(this.eventToPromise(user, "ready"));
          user.muted = !users[userId].audio;
          this.addUser(user);
        }
        Promise.all(promises).then(res);
      });
    });
  }
  eventToPromise(emitter: EventEmitter | User, event: string) {
    return new Promise((res) => {
      emitter.once(event, (data: any) => {
        res(data);
      });
    });
  }
  connectTransport(id: string, params) {
    return new Promise((res, rej) => {
      const request = {
        id: ++this.currId,
        type: "ConnectTransport",
        data: {
          id: id,
          dtlsParameters: params,
        },
      };
      this.ws.send(JSON.stringify(request));
      this.on("ConnectTransport", (data: { id: number; data: {} }) => {
        if (data.id !== request.id) return;
        res(data.data);
      });
    });
  }
  startProduce(type: "audio", params) {
    return new Promise((res, rej) => {
      const request = {
        id: ++this.currId,
        type: "StartProduce",
        data: {
          type: type,
          rtpParameters: params,
        },
      };
      this.ws.send(JSON.stringify(request));
      this.on("StartProduce", (data: { id: number; data: { producerId: string } }) => {
        if (data.id !== request.id) return;
        res(data.data.producerId);
      });
    });
  }
  stopProduce(type = "audio") {
    return new Promise((res) => {
      const request = {
        id: ++this.currId,
        type: "StopProduce",
        data: {
          type: type,
        },
      };
      this.ws.send(JSON.stringify(request));
      this.on("StopProduce", (data: { id: number }) => {
        if (data.id !== request.id) return;
        res(void 0);
      });
    });
  }
}

module.exports = Signaling;
