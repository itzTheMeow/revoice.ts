import EventEmitter from "events";
import fs, { ReadStream } from "fs";
import ffmpeg from "ffmpeg-static";
import { createSocket, Socket } from "dgram";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { Stream } from "stream";
import { Transport } from "msc-node/lib/Transport";
import { Producer } from "msc-node/lib/Producer";
import { MediaStreamTrack } from "werift";

export class Media {
  public track: MediaStreamTrack;
  public socket: Socket;
  public playing = false;
  public isMedia = true;
  public ffmpeg: ChildProcessWithoutNullStreams;
  public isMediaPlayer = false;

  constructor(
    public logs = false,
    public port = 5030,
    packetHandler = (packet) => {
      this.track.writeRtp(packet);
    },
    public customArgs: string[] = []
  ) {
    this.track = new MediaStreamTrack({ kind: "audio" });
    this.socket = createSocket("udp4");
    this.socket.bind(port);

    this.socket.on("message", (packet) => {
      packetHandler(packet); // defined in constructor params
    });

    this.ffmpeg = spawn(ffmpeg, [
      "-re",
      "-i",
      "-",
      "-map",
      "0:a",
      "-b:a",
      "48k",
      "-maxrate",
      "48k",
      "-c:a",
      "libopus",
      "-f",
      "rtp",
      "rtp://127.0.0.1:" + port,
    ]);
    if (logs) {
      this.ffmpeg.stdout.on("data", (data) => {
        console.log(Buffer.from(data).toString());
      });
      this.ffmpeg.stderr.on("data", (data) => {
        console.log(Buffer.from(data).toString());
      });
    }

    return this;
  }
  // Unimplemented
  on(event: string, cb: any) {}
  once(event: string, cb: any) {}
  createFfmpegArgs(start = "00:00:00") {
    return [
      "-re",
      "-i",
      "-",
      "-ss",
      start,
      ...this.customArgs,
      "-map",
      "0:a",
      "-b:a",
      "48k",
      "-maxrate",
      "48k",
      "-c:a",
      "libopus",
      "-f",
      "rtp",
      "rtp://127.0.0.1:" + this.port,
    ];
  }
  getMediaTrack() {
    return this.track;
  }
  playFile(path: string) {
    if (!path) throw "You must specify a file to play!";
    const stream = fs.createReadStream(path);
    stream.pipe(this.ffmpeg.stdin);
  }
  writeStreamChunk(chunk: any) {
    if (!chunk) throw "You must pass a chunk to be written into the stream";
    this.ffmpeg.stdin.write(chunk);
  }
  playStream(stream: Stream) {
    if (!stream) throw "You must specify a stream to play!";
    stream.pipe(this.ffmpeg.stdin);
  }
  destroy() {
    return new Promise((res, rej) => {
      this.track = null;
      this.ffmpeg.kill();
      this.socket.close(() => res(void 0));
    });
  }
}

type MediaPlayerEvents = "start" | "finish" | "pause" | "buffer";
export class MediaPlayer extends Media {
  public emitter = new EventEmitter();
  public currTime = null;
  public started = false;
  public packets = [];
  public intervals = [];
  public lastPacket = null;
  public paused = false;
  public streamFinished = false;
  public originStream: ReadStream;
  public sendTransport: Transport;
  public writing = false;
  public producer: Producer;

  constructor(logs = false, port = 5030, customArgs: string[] = []) {
    super(
      logs,
      port,
      (packet) => {
        if (!this.started) {
          this.started = true;
          this.emit("start");
        }
        if (this.paused) {
          return this._save(packet);
        }
        if (packet == "FINISHPACKET") return this.finished();
        this.track.writeRtp(packet);
      },
      customArgs
    );
    this.isMediaPlayer = true;
    return this;
  }
  on(event: MediaPlayerEvents, cb: any) {
    return this.emitter.on(event, cb);
  }
  once(event: MediaPlayerEvents, cb: any) {
    return this.emitter.once(event, cb);
  }
  emit(event: MediaPlayerEvents, data?: any) {
    return this.emitter.emit(event, data);
  }

  static timestampToSeconds(timestamp = "00:00:00", ceilMinutes = false) {
    const stamp = timestamp
      .split(":")
      .map((el, index) =>
        index < 2 ? parseInt(el) : ceilMinutes ? Math.ceil(parseFloat(el)) : parseFloat(el)
      );
    const hours = stamp[0];
    const minutes = stamp[1];
    const currSeconds = stamp[2];
    return hours * 60 * 60 + minutes * 60 + currSeconds; // convert everything to seconds
  }

  _save(packet) {
    let time = Date.now();
    if (!this.lastPacket) this.lastPacket = time;
    this.intervals.push(time - this.lastPacket);
    this.lastPacket = time + 2;
    this.packets.push(packet);
  }
  _write() {
    if (this.packets.length == 0) {
      this.paused = false;
      return (this.writing = false);
    }
    this.writing = true;
    let interval = this.intervals.shift();
    let packet = this.packets.shift();
    setTimeout(() => {
      if (packet == "FINISHPACKET") {
        this.finished();
        return this._write();
      }
      this.track.writeRtp(packet);
      this._write();
    }, interval);
  }
  disconnect(destroy = true, f = true) {
    // this should be called on leave
    if (destroy) this.track = new MediaStreamTrack({ kind: "audio" }); // clean up the current data and streams
    this.paused = false;
    if (f) this.ffmpeg.kill();
    this.originStream.destroy();
    this.currTime = "00:00:00";

    if (f) {
      this.ffmpeg = require("child_process").spawn(ffmpeg, [
        // set up new ffmpeg instance
        ...this.createFfmpegArgs(),
      ]);
    }
    this.packets = [];
    this.intervals = [];
    this.started = false;
    if (f) this.#setupFmpeg();
  }
  destroy() {
    return Promise.all([
      super.destroy(),
      new Promise((res) => {
        this.packets = [];
        this.intervals = [];
        this.originStream.destroy();
        res(void 0);
      }),
    ]);
  }
  finished() {
    this.track = new MediaStreamTrack({ kind: "audio" });
    this.playing = false;
    this.paused = false;
    this.disconnect(false, false);
    this.emit("finish");
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  resume() {
    if (!this.paused) return;
    this.emit("start");
    this._write();
  }
  stop() {
    return new Promise(async (res) => {
      this.ffmpeg.kill();
      this.ffmpeg = require("child_process").spawn(ffmpeg, [
        // set up new ffmpeg instance
        ...this.createFfmpegArgs(),
      ]);
      await this.sleep(1000);
      this.paused = false;
      this.originStream.destroy();

      this.packets = [];
      this.intervals = [];
      this.started = false;
      this.track = new MediaStreamTrack({ kind: "audio" });
      this.emit("finish");
      res(void 0);
    });
  }
  sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
  get streamTrack() {
    if (!this.track) this.track = new MediaStreamTrack({ kind: "audio" });
    return this.getMediaTrack();
  }
  async playStream(stream: ReadStream) {
    if (this.sendTransport)
      this.producer = await this.sendTransport.produce({
        track: this.track as unknown as globalThis.MediaStreamTrack,
        appData: { type: "audio" },
      });
    this.emit("buffer", this.producer);
    this.started = false;
    this.streamFinished = false;
    this.originStream = stream;
    this.originStream.on("end", () => {
      this.streamFinished = true;
    });

    // ffmpeg stuff
    this.#setupFmpeg();

    super.playStream(stream); // start playing
  }
  async #ffmpegFinished() {
    await this.sleep(1000); // prevent bug with no music after 3rd song
    this.socket.send("FINISHPACKET", this.port);
    this.originStream.destroy();
    this.ffmpeg.kill();
    this.currTime = "00:00:00";
    this.ffmpeg = require("child_process").spawn(ffmpeg, [
      // set up new ffmpeg instance
      ...this.createFfmpegArgs(),
    ]);
  }
  #setupFmpeg() {
    this.ffmpeg.on("exit", async (_c, s) => {
      if (s == "SIGTERM") return; // killed intentionally
      this.#ffmpegFinished();
    });
    this.ffmpeg.stdin.on("error", (e: Error) => {
      if ((e as any).code == "EPIPE") return;
      console.log("Ffmpeg error: ", e);
    });
    if (!this.logs) return;
    this.ffmpeg.stderr.on("data", (chunk) => {
      console.log("err", Buffer.from(chunk).toString());
    });
    this.ffmpeg.stdout.on("data", (chunk) => {
      console.log("OUT", Buffer.from(chunk().toString()));
    });
    this.ffmpeg.stdout.on("end", () => {
      console.log("finished");
    });
    this.ffmpeg.stdout.on("readable", () => {
      console.log("readable");
    });
  }
}
